/**
 * Application entry point.
 *
 * Responsibilities kept deliberately small:
 *  - load and validate configuration;
 *  - connect to Minecraft;
 *  - wire the subsystems together;
 *  - own the lifecycle (start / stop / shutdown).
 */
import { loadConfig, ConfigError, type AppConfig } from './config/config.js';
import { createLogger, type Logger } from './utils/logger.js';
import { createBot, type ConnectedBot } from './bot/createBot.js';
import { MineflayerFacade } from './bot/mineflayerFacade.js';
import { HumanPresenceMonitor } from './bot/humanPresence.js';
import { reconnect, policyFrom, isFatalDisconnect } from './bot/reconnect.js';
import { wireBotEvents } from './bot/events.js';
import { AuthorizationService } from './safety/permissions.js';
import { AntiGriefRules } from './safety/antiGrief.js';
import { ActionLimits } from './safety/actionLimits.js';
import { TaskManager } from './executor/actionQueue.js';
import { ActionExecutor } from './executor/actionExecutor.js';
import { ChatListener } from './chat/chatListener.js';
import { ChatResponder } from './chat/responses.js';
import { LocalCommands } from './commands/index.js';
import { createSkillRegistry } from './skills/index.js';
import { AIManager } from './ai/AIManager.js';
import { buildCompactContext } from './ai/contextBuilder.js';
import { createMemoryStore } from './ai/memory.js';
import type { MemoryStore } from './types/memory.js';
import type { BotAction } from './types/actions.js';
import { safeChatReply } from './safety/chatInjectionGuard.js';
import { BOT_TIMING } from './config/constants.js';
import { startHealthServer, type HealthServerHandle } from './healthServer.js';
import { fileURLToPath } from 'node:url';

/**
 * A session shorter than this counts as "the server rejected the bot" rather
 * than "the server restarted". Three of those in a row stop the bot instead
 * of hammering the server with reconnects.
 */
const MIN_SESSION_UPTIME_MS = 30_000;
const MAX_DROPPED_SESSIONS = 3;

interface Wiring {
  responder: ChatResponder;
  memory: MemoryStore;
}

export class BotApp {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private connection: ConnectedBot | null = null;
  private facade: MineflayerFacade | null = null;
  private presence: HumanPresenceMonitor | null = null;
  tasks: TaskManager | null = null;
  private executor: ActionExecutor | null = null;
  private ai: AIManager | null = null;
  private wiring: Wiring | null = null;
  private stopping = false;
  /** True while a post-drop reconnect loop is running ('end' + 'kicked' both fire). */
  private reconnecting = false;
  /** Aborted by shutdown() so a pending reconnect sleep/attempt gives up at once. */
  private readonly lifecycle = new AbortController();
  /** Detach function for the current bot's event listeners. */
  private detachEvents: (() => void) | null = null;
  /** Platform keep-alive listener (Render etc.); auxiliary, never fatal. */
  private readonly health: HealthServerHandle | null;
  /** Memoised shutdown: concurrent callers wait for the same shutdown. */
  private shutdownPromise: Promise<void> | null = null;
  /**
   * Sessions that connected and were dropped again without the bot doing any
   * work. A server that accepts the join and then kicks the bot would
   * otherwise be retried forever (a reconnect storm).
   */
  private droppedSessions = 0;
  /**
   * When the current session connected (null until the first session).
   *
   * Kept after a teardown so the next drop can still be measured against
   * the session it belongs to.
   */
  private connectedAt: number | null = null;
  /** Periodic housekeeping timer; released on shutdown. */
  private housekeeping: NodeJS.Timeout | null = null;

  private constructor(config: AppConfig, logger: Logger, health: HealthServerHandle | null = null) {
    this.config = config;
    this.logger = logger;
    this.health = health;
  }

  /** Builds an app from configuration. Throws ConfigError if invalid. */
  static async create(env: NodeJS.ProcessEnv = process.env): Promise<BotApp> {
    const config = await loadConfig(env);
    const logger = createLogger({
      level: config.runtime.logLevel,
      format: config.runtime.logFormat,
      base: { bot: config.minecraft.username },
    });
    logger.info('configuration loaded', {
      host: config.minecraft.host,
      port: config.minecraft.port,
      auth: config.minecraft.auth,
      authorizedPlayers: config.authorizedPlayers.size,
      providers: config.ai.providers.map((p) => p.name),
    });
    // Non-fatal advisories (e.g. MC_AUTH=offline) - visible, never fatal.
    for (const warning of config.warnings) {
      logger.warn('configuration warning', { warning });
    }
    // Start the platform keep-alive listener before connecting so the host
    // already sees an open port while the bot is still joining.
    const health = config.runtime.healthPort === undefined
      ? null
      : await startHealthServer(config.runtime.healthPort, logger).catch((error: unknown) => {
          logger.warn('health server could not start (bot continues without it)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
    return new BotApp(config, logger, health);
  }

  /** Connects and starts all subsystems. Retries are bounded, never infinite. */
  async start(): Promise<void> {
    try {
      await this.connect();
      this.logger.info('bot ready');
    } catch (error) {
      // A shutdown that raced the startup (a SIGTERM during the spawn wait)
      // is not a connection failure: the app is going down, so it must not
      // be reported as a fatal error.
      if (this.stopping) {
        this.logger.info('startup aborted by shutdown');
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('initial connection failed', { error: message });

      const outcome = await reconnect({
        logger: this.logger.child({ component: 'reconnect' }),
        policy: policyFrom(
          this.config.runtime.maxReconnectAttempts,
          this.config.runtime.reconnectBaseDelayMs,
        ),
        connect: () => this.connect(),
        signal: this.lifecycle.signal,
      });

      if (outcome !== 'connected') {
        if (outcome === 'aborted' || this.stopping) {
          // The shutdown won the race while we were backing off.
          this.logger.info('startup aborted by shutdown');
          return;
        }
        throw new Error(`could not connect to ${this.config.minecraft.host} (${outcome})`);
      }
      this.logger.info('bot ready after reconnect');
    }
  }

  /** Establishes a connection and wires every subsystem to it. */
  private async connect(): Promise<void> {
    const connection = await createBot({
      config: this.config.minecraft,
      logger: this.logger,
    });
    // A shutdown may have arrived while we were waiting for the spawn: the
    // app is going down, so this session must not be installed. Without this
    // check the bot would stay connected after the shutdown had finished and
    // its socket would keep the process alive on a host that is already
    // tearing the service down.
    if (this.stopping) {
      this.quitBot(connection, 'shutting down');
      throw new Error('connection aborted: the app is shutting down');
    }
    this.connection = connection;
    // Remember when this session started: a session that dies within
    // MIN_SESSION_UPTIME_MS was rejected, not interrupted.
    this.connectedAt = Date.now();

    // The server can drop us between the spawn and the event wiring below.
    // Nothing listens for 'end' yet (waitForSpawn removes its listeners as
    // soon as it settles), so such a drop would simply be lost: the connect
    // would report success and the app would sit there with a dead bot that
    // never reconnects. Remember it and fail the connect instead.
    let endedEarly = false;
    connection.bot.once('end', () => {
      endedEarly = true;
    });

    const facade = new MineflayerFacade(connection.bot, this.logger);
    const auth = new AuthorizationService(this.config);
    // Let the facade label players as authorized in world snapshots.
    facade.isAuthorizedName = (name: string) => auth.isAuthorized(name);
    this.facade = facade;

    const memory = createMemoryStore({
      logger: this.logger,
      ...(this.config.runtime.memoryFile ? { file: this.config.runtime.memoryFile } : {}),
    });
    await memory.load().catch((error: unknown) => {
      this.logger.warn('could not load persistent memory', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    const tasks = new TaskManager(this.logger);
    this.tasks = tasks;

    const ai = new AIManager({ config: this.config.ai, logger: this.logger });
    this.ai = ai;

    const responder = new ChatResponder(this.logger);
    // The responder writes straight to Minecraft chat.
    responder.emit = (text: string) => {
      try {
        facade.chat(text);
      } catch (error) {
        this.logger.warn('chat send failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    this.wiring = { responder, memory };

    const executor = new ActionExecutor({
      facade,
      tasks,
      limits: new ActionLimits(this.config.safety),
      antiGrief: new AntiGriefRules(),
      logger: this.logger,
      registry: createSkillRegistry(facade),
      say: (target, message) => {
        void responder.send(target, message).catch(() => undefined);
      },
    });
    this.executor = executor;

    const local = new LocalCommands({
      facade,
      tasks,
      auth,
      memory,
      responder,
      prefix: this.config.chat.prefix,
      providerStats: () => ai.brainLabel(),
      runAction: (owner, action) => this.runDeterministic(owner, action),
      logger: this.logger,
    });

    const listener = new ChatListener({
      facade,
      auth,
      responder,
      memory,
      prefix: this.config.chat.prefix,
      logger: this.logger,
      runDeterministic: (owner, action) => this.runDeterministic(owner, action),
      handleNaturalLanguage: (owner, text) => this.handleNaturalLanguage(owner, text),
      stopEverything: (reason) => this.stopEverything(reason),
      handleLocal: (owner, name, args) => local.handle(owner, name, args),
    });

    this.detachEvents = wireBotEvents({
      bot: connection.bot,
      logger: this.logger,
      onChat: (username, message) => {
        void listener.handle({ username, message }).catch((error: unknown) => {
          this.logger.error('chat handler crashed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      onDisconnect: (reason) => {
        // Fire and forget, but never unhandled: a rejected promise would
        // take the whole process down.
        void this.onDisconnected(reason).catch((error: unknown) => {
          this.logger.error('disconnect handler failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
    });

    const presence = new HumanPresenceMonitor(
      this.config.presence,
      facade,
      (name) => auth.isAuthorized(name),
      this.logger,
    );
    presence.setDisconnectHandler((reason) => {
      this.logger.info('leaving: Aternos safe mode active', { reason });
      this.stopEverything('no authorized human online');
      // Fire and forget, but never unhandled: a rejected promise would take
      // the whole process down instead of letting it exit cleanly.
      void this.shutdown('no-authorized-human').catch((error: unknown) => {
        this.logger.error('shutdown failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    this.presence = presence;
    presence.start();

    await responder.announce('Online. Type !help for commands.');

    if (endedEarly) {
      // The connection died while the session was being built: fail the
      // connect so the bounded reconnect loop tries again instead of
      // reporting a dead bot as ready.
      await this.abortSession('the server dropped the connection during startup');
      throw new Error('the server closed the connection while the bot was starting');
    }

    // Periodic housekeeping: drop settled tasks so memory stays flat.
    this.startHousekeeping();
  }

  /**
   * Starts the periodic housekeeping that drops settled tasks.
   *
   * The timer is unref'd - it must never be the reason the process stays
   * alive - and it is released again when the app shuts down.
   */
  private startHousekeeping(): void {
    if (this.housekeeping !== null) return;
    this.housekeeping = setInterval(() => {
      this.tasks?.prune();
    }, BOT_TIMING.TICK_MS * 60);
    this.housekeeping.unref();
  }

  /**
   * Releases a session that must not survive: its listeners, timers, AI
   * sockets and the client socket itself.
   */
  private async abortSession(reason: string): Promise<void> {
    const connection = this.connection;
    const ai = this.teardownSession(reason);
    this.quitBot(connection, reason);
    try {
      await ai?.dispose();
    } catch (error) {
      this.logger.debug('ai dispose failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Quits a client, ignoring failures of an already dead connection. */
  private quitBot(connection: ConnectedBot | null, reason: string): void {
    try {
      connection?.bot.quit(reason);
    } catch (error) {
      this.logger.debug('quit failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Runs a deterministic command action with no AI involved. */
  private async runDeterministic(owner: string, action: BotAction): Promise<void> {
    if (!this.executor) return;
    // `!come` targets the requesting player.
    const resolved: BotAction =
      action.type === 'move_to_player' && action.player === ''
        ? { ...action, player: owner }
        : action;

    this.logger.info('deterministic command', {
      owner,
      action: resolved.type,
      ...(resolved.type === 'move_to_player' ? { player: resolved.player } : {}),
    });

    const outcome = await this.executor.runSingle(owner, resolved);
    if (outcome.cancelled) return;
    if (!outcome.ok && outcome.detail) {
      await this.say(owner, `Could not do that: ${outcome.detail}`);
    }
  }

  /** Routes a natural-language request through the AI planner. */
  private async handleNaturalLanguage(owner: string, text: string): Promise<void> {
    const { ai, executor, wiring } = this;
    if (!ai || !executor || !wiring || !this.facade) return;

    wiring.memory.noteInstruction(owner, text);
    wiring.memory.setTargetPlayer(owner);

    // Everything in flight is cancelled by a new request: the newest
    // instruction wins, which is how players expect a companion to behave.
    this.stopEverything('new request');

    await this.say(owner, 'Got it, working on it.');

    try {
      // planDetailed keeps the drop/reason detail so we can explain refusals.
      // The facade already satisfies WorldContextSource; the rolling session state
      // supplies the conversational window, target player and objective.
      const session = wiring.memory.shortTerm;
      const compact = buildCompactContext(this.facade, session, {
        logger: this.logger,
      });
      const plan = await ai.planDetailed({
        instruction: text,
        requester: owner,
        context: compact,
      });

      if (plan.actions.length === 0) {
        const dropped = plan.dropped[0];
        const why = dropped ? `: ${safeChatReply(dropped.reason, 80)}` : '.';
        await this.say(owner, `I could not work out how to do that${why}`);
        wiring.memory.noteFailure('plan', dropped?.reason ?? 'no valid actions');
        return;
      }

      wiring.memory.setObjective(text);
      const outcome = await executor.runPlan(owner, plan.actions);
      await this.reportOutcome(owner, outcome);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('natural language handling failed', { owner, error: message });
      wiring.memory.noteFailure('plan', message);
      await this.say(owner, 'Sorry, I could not handle that request.');
    }
  }

  private async reportOutcome(
    owner: string,
    outcome: { completed: string[]; failed: Array<{ action: string; reason: string }>; cancelled: boolean },
  ): Promise<void> {
    if (outcome.cancelled) {
      await this.say(owner, 'Stopped.');
      return;
    }
    if (outcome.failed.length > 0) {
      const summary = outcome.failed
        .slice(0, 2)
        .map((f) => `${f.action.replace(/_/g, ' ')}: ${safeChatReply(f.reason, 60)}`)
        .join('; ');
      await this.say(owner, `Finished ${outcome.completed.length} step(s). Issue - ${summary}`);
      return;
    }
    if (outcome.completed.length > 0) {
      await this.say(owner, `Done (${outcome.completed.map((c) => c.replace(/_/g, ' ')).join(', ')}).`);
    }
  }

  /** Cancels every task, plan and AI request immediately. */
  private stopEverything(reason: string): void {
    const cancelledTasks = this.tasks?.cancelAll(reason) ?? 0;
    const cancelledPlan = this.executor?.cancelActivePlan(reason) ?? false;
    const cancelledAi = this.ai?.cancelAll(reason) ?? 0;
    this.facade?.stopMoving();
    this.logger.info('stop requested', { reason, cancelledTasks, cancelledPlan, cancelledAi });
  }

  private async say(target: string, message: string): Promise<void> {
    const responder = this.wiring?.responder;
    if (responder) {
      await responder.send(target, message);
      return;
    }
    this.facade?.chat(safeChatReply(`${target}, ${message}`));
  }

  /**
   * Handles a live-connection loss.
   *
   * Aternos restarts, throttles and drops clients routinely, so a single drop
   * must not kill the process: we tear down the dead session and run the same
   * bounded reconnect loop used at startup. Unrecoverable kicks (whitelist,
   * ban, auth) still stop immediately, and so does any drop that happens
   * while we are already shutting down.
   */
  private async onDisconnected(reason: string): Promise<void> {
    this.logger.warn('disconnected from server', { reason });
    this.presence?.noteDisconnected();
    if (this.stopping) return;

    if (isFatalDisconnect(reason)) {
      this.logger.error('fatal disconnect - not retrying', { reason });
      await this.shutdown(`fatal disconnect: ${reason}`);
      return;
    }

    // 'end' and 'kicked' both fire for one drop; only the first starts a loop.
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.logger.info('connection lost - attempting bounded reconnect', { reason });

    // A server that accepts the join and immediately drops it again would be
    // retried forever (a reconnect storm that can get the account banned).
    // Count sessions that died young and stop once the pattern is obvious.
    const uptimeMs = this.connectedAt === null ? 0 : Date.now() - this.connectedAt;
    if (uptimeMs < MIN_SESSION_UPTIME_MS) {
      this.droppedSessions += 1;
    } else {
      this.droppedSessions = 0;
    }
    if (this.droppedSessions >= MAX_DROPPED_SESSIONS) {
      this.logger.error('server keeps dropping the bot right after joining - giving up', {
        reason,
        droppedSessions: this.droppedSessions,
      });
      process.exitCode = 1;
      await this.shutdown('repeated immediate disconnects');
      return;
    }

    try {
      const oldAi = this.teardownSession(`disconnected: ${reason}`);
      // Release the previous session's provider sockets before reconnecting.
      await oldAi?.dispose().catch((error: unknown) => {
        this.logger.warn('ai dispose failed during reconnect', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      const outcome = await reconnect({
        logger: this.logger.child({ component: 'reconnect' }),
        policy: policyFrom(
          this.config.runtime.maxReconnectAttempts,
          this.config.runtime.reconnectBaseDelayMs,
        ),
        connect: () => this.connect(),
        signal: this.lifecycle.signal,
        onRetry: (attempt, delayMs) => {
          this.logger.info('waiting before reconnect attempt', { attempt, delayMs });
        },
      });

      if (outcome === 'connected') {
        this.logger.info('reconnected after disconnect');
        return;
      }
      if (outcome === 'aborted' || this.stopping) return; // shutdown won the race
      this.logger.error('giving up after disconnect - reconnect attempts exhausted', { outcome });
      // Non-zero so a supervisor (or plain `echo $?`) can tell this apart from
      // an intentional stop (safe mode / SIGINT).
      process.exitCode = 1;
      await this.shutdown(`reconnect ${outcome}`);
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Cancels all in-flight work and releases the current session's subsystems
   * WITHOUT marking the app as stopping - used before a reconnect, where the
   * next connect() will build fresh ones. Returns the detached AI manager so
   * the caller can dispose() it (dispose must complete, so it stays async-free
   * here and is handled by the caller).
   */
  private teardownSession(reason: string): AIManager | null {
    this.detachEvents?.();
    this.detachEvents = null;
    this.presence?.stop();
    this.presence = null;
    this.stopEverything(reason);
    this.tasks?.prune();
    this.tasks = null;
    this.wiring?.responder.clear();
    this.wiring = null;
    this.executor = null;
    const ai = this.ai;
    this.ai = null;
    this.facade = null;
    this.connection = null;
    return ai;
  }

  /** Orderly shutdown: cancel work, stop timers, quit the client. */
  async shutdown(reason: string): Promise<void> {
    // Memoised: a second caller (a SIGTERM arriving while the presence
    // monitor is already shutting down) must WAIT for the first shutdown
    // instead of returning immediately and letting the process exit before
    // the bot quit cleanly.
    if (!this.shutdownPromise) {
      this.stopping = true;
      this.shutdownPromise = this.runShutdown(reason);
    }
    return this.shutdownPromise;
  }

  private async runShutdown(reason: string): Promise<void> {
    try {
      this.logger.info('shutting down', { reason });
      // Unwind any pending reconnect sleep/attempt immediately.
      this.lifecycle.abort();

      // Release the periodic housekeeping timer.
      if (this.housekeeping !== null) {
        clearInterval(this.housekeeping);
        this.housekeeping = null;
      }

      const connection = this.connection;
      const ai = this.teardownSession(reason);

      // dispose() aborts in-flight AI requests, so it must complete.
      try {
        await ai?.dispose();
      } catch (error) {
        this.logger.warn('ai dispose failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      this.quitBot(connection, reason);

      // Release the keep-alive port last: the platform may still be probing it.
      try {
        await this.health?.close();
      } catch (error) {
        this.logger.debug('health server close failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      // A shutdown must never reject: its callers are fire and forget (the
      // signal handlers, the presence monitor) and an unhandled rejection
      // would kill the process instead of letting it exit cleanly.
      try {
        this.logger.error('shutdown failed', {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Even the log line failed - there is nothing left to report it with.
      }
    }
  }
}

/** Process entry point. */
async function main(): Promise<void> {
  let app: BotApp | undefined;
  try {
    app = await BotApp.create();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Config errors are user-actionable: no stack trace, just what to fix.
      process.stderr.write(`${error.message}\n\nSee .env.example for all options.\n`);
      process.exitCode = 1;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Fatal: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  const active = app;
  const shutdown = (signal: string): void => {
    // No process.exit(): the event loop drains on its own once the socket and
    // the health server are closed, and stdout is flushed properly. A forced
    // exit regularly swallowed the last log lines.
    void active.shutdown(signal).catch((error: unknown) => {
      process.stderr.write(`shutdown failed: ${String(error)}\n`);
    });
  };
  // Registered BEFORE the (possibly slow) startup: a SIGTERM during the
  // reconnect backoff must still close the bot and release the port.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await active.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Fatal: ${message}\n`);
    process.exitCode = 1;
    // Release the health server: otherwise the open listener keeps the event
    // loop alive, the process never exits, and the platform keeps billing a
    // service that gave up connecting.
    await active.shutdown('startup failed').catch(() => undefined);
    return;
  }
}

/**
 * True when this module is the process entry point.
 *
 * `import.meta.url` is a file:// URL while `process.argv[1]` is a native path,
 * and the two differ on Windows (drive letter casing and slash direction), so
 * both are normalised to a comparable form before comparing.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const selfPath = fileURLToPath(import.meta.url);
  const normalise = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalise(selfPath) === normalise(entry);
}

if (isMainModule()) {
  void main();
}

export { main };
