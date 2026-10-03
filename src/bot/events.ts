/**
 * Mineflayer event wiring.
 *
 * Kept in its own module so `index.ts` stays about composition rather than
 * protocol details. Every handler is defensive: an unhandled rejection or a
 * throwing listener must never take the bot process down.
 */
import type { Bot } from 'mineflayer';
import type { Logger } from '../utils/logger.js';

export interface BotEventHandlers {
  /** A player said something in chat. */
  onChat: (username: string, message: string) => void;
  /** The connection went away for any reason. */
  onDisconnect: (reason: string) => void;
  /** Optional: the bot died. */
  onDeath?: () => void;
  /** Optional: health/hunger crossed a dangerous threshold. */
  onCritical?: (kind: 'health' | 'hunger', value: number) => void;
  /** Health below which the bot is considered in danger. */
  criticalHealth?: number;
  criticalHunger?: number;
}

export interface WireOptions extends BotEventHandlers {
  bot: Bot;
  logger: Logger;
}

/**
 * Narrow an unknown chat payload to the fields we need. Written as an explicit
 * record read so the compiler (and lint) can verify the types.
 */
function readChatFields(value: unknown): { username: string; message: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const username = record['username'];
  const message = record['message'];
  if (typeof username !== 'string' || typeof message !== 'string') return null;
  return { username, message };
}

/**
 * Attaches listeners and returns a detach function.
 * Detaching matters on reconnect so listeners do not accumulate.
 */
export function wireBotEvents(options: WireOptions): () => void {
  const { bot, logger } = options;
  const log = logger.child({ component: 'events' });
  const criticalHealth = options.criticalHealth ?? 6;

  const onMessage = (jsonMsg: unknown, position: string): void => {
    void position;
    const fields = readChatFields(jsonMsg);
    if (fields === null) return;
    try {
      options.onChat(fields.username, fields.message);
    } catch (error) {
      log.error('chat listener threw', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onEnd = (reason: unknown): void => {
    const text = typeof reason === 'string' ? reason : 'connection closed';
    try {
      options.onDisconnect(text);
    } catch (error) {
      log.error('disconnect handler threw', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onKicked = (reason: unknown): void => {
    const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
    log.warn('kicked', { reason: text });
    try {
      options.onDisconnect(`kicked: ${text}`);
    } catch (error) {
      log.error('kick handler threw', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onError = (error: Error): void => {
    log.error('bot error', { error: error.message });
  };

  const onDeath = (): void => {
    log.warn('the bot died');
    options.onDeath?.();
  };

  const onHealth = (): void => {
    if ((bot.health ?? 20) <= criticalHealth) {
      options.onCritical?.('health', bot.health ?? 0);
    }
  };

  bot.on('message', onMessage);
  bot.on('end', onEnd);
  bot.on('kicked', onKicked);
  bot.on('error', onError);
  bot.on('death', onDeath);
  bot.on('health', onHealth);

  return function detach(): void {
    bot.removeListener('message', onMessage);
    bot.removeListener('end', onEnd);
    bot.removeListener('kicked', onKicked);
    bot.removeListener('error', onError);
    bot.removeListener('death', onDeath);
    bot.removeListener('health', onHealth);
  };
}