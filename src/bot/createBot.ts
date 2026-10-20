/**
 * Bot creation and mineflayer wiring.
 *
 * Keeps `createBot` a pure factory: it connects, loads pathfinder, and
 * resolves once the bot has spawned. All error handling is the caller's job.
 */
import mineflayer, { type Bot } from 'mineflayer';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import type { Movements as MovementsType } from 'mineflayer-pathfinder';
import type { MinecraftConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';

/** Default for callers that don't pass a config (tests, tooling). */
const SPAWN_TIMEOUT_MS = 60_000;

/**
 * No-packet threshold before mineflayer declares the connection dead.
 * Aternos free servers lag in bursts; the 30s library default (and even 60s)
 * can be exceeded during a world save, so we are deliberately more patient.
 */
const KEEP_ALIVE_TIMEOUT_MS = 120_000;

export interface ConnectedBot {
  bot: Bot;
  movements: MovementsType;
}

export interface CreateBotOptions {
  config: MinecraftConfig;
  logger: Logger;
  /** Extra pathfinder movement options (e.g. allow1by1towers). */
  pathfinder?: Partial<MovementsType>;
  spawnTimeoutMs?: number;
}

/**
 * Creates a mineflayer bot and loads the pathfinder plugin.
 * Rejects (rather than hanging) if spawn does not happen in time.
 */
export async function createBot(options: CreateBotOptions): Promise<ConnectedBot> {
  const { config, logger } = options;

  const auth = config.auth;
  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    // 'microsoft' is the normal path. Offline mode is opt-in via MC_AUTH and
    // is intentionally passed through rather than defaulted.
    auth: auth === 'offline' ? 'offline' : 'microsoft',
    ...(config.version ? { version: config.version } : {}),
    ...(config.profilesPath ? { profilesFolder: config.profilesPath } : {}),
    // The bot must never spam the server with chat.
    chatLengthLimit: 100,
    checkTimeoutInterval: KEEP_ALIVE_TIMEOUT_MS,
  });

  // The plugin is a static export and can be loaded immediately, but `Movements`
  // reads bot.registry, which only exists once the protocol handshake has
  // completed - so it must be constructed after spawn.
  bot.loadPlugin(pathfinder);

  try {
    await waitForSpawn(
      bot,
      logger,
      options.spawnTimeoutMs ?? config.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS,
    );
  } catch (error) {
    // A failed spawn (timeout, kick, handshake error) can leave the TCP socket
    // half-open. Repeated retries against a slow host would leak connections,
    // so always tear the client down before surfacing the error.
    try {
      bot.quit('spawn failed');
    } catch {
      // The client may never have reached a quittable state; nothing to do.
    }
    throw error;
  }

  const movements = new Movements(bot);
  movements.canDig = false; // Never punch through terrain to make progress.
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.allowSprinting = true;
  Object.assign(movements, options.pathfinder ?? {});
  // Hand the tuned movements to the plugin so every goto uses them.
  (bot as unknown as { pathfinder?: { setMovements?: (m: MovementsType) => void } }).pathfinder
    ?.setMovements?.(movements);

  // Keep an error listener attached for the whole session. An EventEmitter
  // 'error' event without a listener THROWS, so a bot error in the window
  // between spawning and the app wiring its own handlers would crash the
  // process (a crash loop on a hosted service).
  bot.on('error', (error: Error) => {
    logger.warn('bot error', { error: error.message });
  });

  logger.info('bot spawned', {
    username: bot.username,
    dimension: bot.game?.dimension,
    version: bot.version,
  });

  return { bot, movements };
}

/**
 * Resolves on `spawn`, rejects on error/timeout/kick.
 *
 * Exported for tests: the rest of `createBot` needs a live server, but this
 * is the part that decides whether the bot ever comes online.
 */
export function waitForSpawn(bot: Bot, logger: Logger, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      bot.removeListener('spawn', onSpawn);
      bot.removeListener('error', onError);
      bot.removeListener('kicked', onKicked);
      clearTimeout(timer);
    };

    const onSpawn = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`connection error: ${error.message}`));
    };

    const onKicked = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
      reject(new Error(`kicked while connecting: ${text}`));
    };

    // One path per outcome: the previous version raced two independent
    // waiters, which left a stray 'spawn' listener behind on the timeout
    // path and could reject after the promise had already resolved.
    bot.on('spawn', onSpawn);
    bot.on('error', onError);
    bot.on('kicked', onKicked);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      logger.warn('spawn wait ended', { timeoutMs });
      reject(new Error(`waiting for spawn timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}