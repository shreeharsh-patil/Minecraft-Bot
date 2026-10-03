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
import { withTimeout } from '../utils/sleep.js';

/** How long we wait for the initial spawn before declaring failure. */
const SPAWN_TIMEOUT_MS = 60_000;

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
    checkTimeoutInterval: 60_000,
  });

  // The plugin is a static export and can be loaded immediately, but `Movements`
  // reads bot.registry, which only exists once the protocol handshake has
  // completed - so it must be constructed after spawn.
  bot.loadPlugin(pathfinder);

  await waitForSpawn(bot, logger, options.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS);

  const movements = new Movements(bot);
  movements.canDig = false; // Never punch through terrain to make progress.
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.allowSprinting = true;
  Object.assign(movements, options.pathfinder ?? {});
  // Hand the tuned movements to the plugin so every goto uses them.
  (bot as unknown as { pathfinder?: { setMovements?: (m: MovementsType) => void } }).pathfinder
    ?.setMovements?.(movements);

  logger.info('bot spawned', {
    username: bot.username,
    dimension: bot.game?.dimension,
    version: bot.version,
  });

  return { bot, movements };
}

/** Resolves on `spawn`, rejects on error/timeout/kick. */
function waitForSpawn(bot: Bot, logger: Logger, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      bot.removeListener('spawn', onSpawn);
      bot.removeListener('error', onError);
      bot.removeListener('kicked', onKicked);
    };

    const onSpawn = (): void => {
      cleanup();
      resolve();
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(new Error(`connection error: ${error.message}`));
    };

    const onKicked = (reason: unknown): void => {
      cleanup();
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
      reject(new Error(`kicked while connecting: ${text}`));
    };

    bot.once('spawn', onSpawn);
    bot.once('error', onError);
    bot.once('kicked', onKicked);

    // Guard against a server that accepts TCP but never completes the handshake.
    withTimeout(
      new Promise<void>((resolveWait) => bot.once('spawn', () => resolveWait())),
      timeoutMs,
      'waiting for spawn',
    ).then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        logger.warn('spawn wait ended', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Always reject with an Error so callers can rely on `.message`.
        reject(
          error instanceof Error ? error : new Error(`waiting for spawn failed: ${String(error)}`),
        );
      },
    );
  });
}