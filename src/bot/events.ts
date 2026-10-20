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
 * Narrow an unknown chat payload to the fields we need.
 *
 * mineflayer 4.35+ emits `message` as a prismarine-chat `ChatMessage` object
 * plus the sender name as a separate argument:
 *
 *   bot.emit('message', msg, 'chat', data.sender, verified)
 *
 * The old implementation read `username`/`message` off the payload, which
 * that object does not have - so EVERY chat line was dropped and the bot was
 * mute: no commands, no replies, not even `!stop`. Legacy servers still emit
 * a JSON string, so both shapes are handled.
 */
function readChatFields(
  value: unknown,
  senderName?: unknown,
): { username: string; message: string } | null {
  // Legacy shape: a JSON string with username/message.
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      const username = record['username'];
      const message = record['message'];
      if (typeof username === 'string' && typeof message === 'string') {
        return { username, message };
      }
    } catch {
      return null;
    }
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  // The sender name arrives as its own argument; fall back to a field on the
  // payload for older shapes.
  const username =
    typeof senderName === 'string' && senderName.length > 0
      ? senderName
      : typeof record['username'] === 'string'
        ? record['username']
        : undefined;
  if (username === undefined) return null;

  // prismarine-chat exposes the plain text through toString(); some payloads
  // carry an explicit `text` field.
  let text = typeof record['text'] === 'string' ? record['text'] : '';
  if (text.length === 0) {
    const chat = value as { toString?: () => string };
    // Object.prototype.toString would give "[object Object]", which is not a
    // chat message - only a custom toString() carries the text.
    if (typeof chat.toString === 'function' && chat.toString !== Object.prototype.toString) {
      try {
        text = chat.toString();
      } catch {
        text = '';
      }
    }
  }
  if (text.length === 0) return null;
  return { username, message: text };
}

/**
 * Attaches listeners and returns a detach function.
 * Detaching matters on reconnect so listeners do not accumulate.
 */
export function wireBotEvents(options: WireOptions): () => void {
  const { bot, logger } = options;
  const log = logger.child({ component: 'events' });
  const criticalHealth = options.criticalHealth ?? 6;

  const onMessage = (message: unknown, position: string, senderName?: unknown): void => {
    void position;
    const fields = readChatFields(message, senderName);
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