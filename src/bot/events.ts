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
 * plus a sender argument:
 *
 *   bot.emit('message', msg, 'chat', data.sender, verified)
 *
 * What `data.sender` contains depends on the protocol version: on 1.19+ the
 * player_chat packet carries a UUID (the name is in the chat component and in
 * the player list), on older servers it is the plain username. Reading the
 * wrong thing makes the bot MUTE, because the UUID never matches
 * AUTHORIZED_PLAYERS - so the name is resolved from several places.
 */
function readChatFields(
  value: unknown,
  senderName?: unknown,
  bot?: Bot,
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

  const username = resolveSenderName(value, senderName, bot);
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
  return { username, message: stripSenderPrefix(text, username) };
}

/**
 * Removes the sender prefix from a rendered chat line.
 *
 * The server sends the message as "<Alice> hello bot"; the listener wants the
 * message itself. Leaving the prefix in place broke every `!` command on
 * 1.19+ (the text no longer started with the prefix, so "!status" was treated
 * as plain chat and handed to the planner).
 */
function stripSenderPrefix(text: string, username: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<')) return trimmed;
  const end = trimmed.indexOf('>');
  if (end === -1) return trimmed;
  const name = trimmed.slice(1, end);
  if (name.toLowerCase() !== username.toLowerCase()) return trimmed;
  return trimmed.slice(end + 1).trimStart();
}

/** True for a Minecraft UUID (dashed or undashed). */
function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(value);
}

/**
 * Finds the name of the player who sent a chat line.
 *
 * 1. The chat component of the message carries the name on modern versions.
 * 2. The sender argument is a UUID on 1.19+: the player list maps it back.
 * 3. On older servers the sender argument IS the name.
 */
function resolveSenderName(
  payload: unknown,
  senderName: unknown,
  bot?: Bot,
): string | undefined {
  // 1. The sender component of the chat message ("Alice").
  const chatSender = (payload as { sender?: { toString?: () => string } }).sender;
  if (chatSender && typeof chatSender.toString === 'function') {
    const name = chatSender.toString().replace(/^<|>$/g, '').trim();
    if (name.length > 0 && !name.startsWith('{')) return name;
  }

  if (typeof senderName !== 'string' || senderName.length === 0) return undefined;

  // 2. A UUID: look the name up in the player list the server sent us.
  if (looksLikeUuid(senderName)) {
    const map = (bot as { uuidToUsername?: Record<string, string> } | undefined)?.uuidToUsername;
    if (map) {
      const flat = senderName.replace(/-/g, '');
      for (const [uuid, username] of Object.entries(map)) {
        if (uuid.replace(/-/g, '') === flat) return username;
      }
    }
    return undefined;
  }

  // 3. Legacy servers pass the username directly.
  return senderName;
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
    const fields = readChatFields(message, senderName, bot);
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