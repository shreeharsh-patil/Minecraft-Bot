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
import { reconnect, policyFrom } from './bot/reconnect.js';
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
import { fileURLToPath } from 'node:url';

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

  private constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
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
    return new BotApp(config, logger);
  }

  /** Connects and starts all subsystems. Retries are bounded, never infinite. */
  async start(): Promise<void> {
    try {
      await this.connect();
      this.logger.info('bot ready');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('initial connection failed', { error: message });

      const outcome = await reconnect({
        logger: this.logger.child({ component: 'reconnect' }),
        policy: policyFrom(
          this.config.runtime.maxReconnectAttempts,
          this.config.runtime.reconnectBaseDelayMs,
        ),
        connect: () => this.connect(),
      });

      if (outcome !== 'connected') {
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
    this.connection = connection;

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
      providerStats: () => ai.stats().providers.length,
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

    wireBotEvents({
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
        void this.onDisconnected(reason);
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
      void this.shutdown('no-authorized-human');
    });
    this.presence = presence;
    presence.start();

    await responder.announce('Online. Type !help for commands.');
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

  private async onDisconnected(reason: string): Promise<void> {
    this.logger.warn('disconnected from server', { reason });
    this.presence?.noteDisconnected();
    if (this.stopping) return;
    await this.shutdown('disconnected');
  }

  /** Orderly shutdown: cancel work, stop timers, quit the client. */
  async shutdown(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.logger.info('shutting down', { reason });

    this.presence?.stop();
    this.stopEverything(reason);
    this.tasks?.prune();
    this.wiring?.responder.clear();

    // dispose() aborts in-flight AI requests, so it must complete.
    try {
      await this.ai?.dispose();
    } catch (error) {
      this.logger.warn('ai dispose failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      this.connection?.bot.quit(reason);
    } catch (error) {
      this.logger.debug('quit failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Process entry point. */
async function main(): Promise<void> {
  let app: BotApp;
  try {
    app = await BotApp.create();
    await app.start();
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
    void active.shutdown(signal).finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Periodic housekeeping: drop settled tasks so memory stays flat.
  const housekeeping = setInterval(() => {
    active.tasks?.prune();
  }, BOT_TIMING.TICK_MS * 60);
  housekeeping.unref();
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
