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
 *
 * The chat component is the strongest source: on 1.19+ the server renders the
 * message from the chat type and puts the sender into the FIRST entry of the
 * `with` array. The payload's own `sender` field is null on 1.21.1, so the
 * component is read from `with[0]`.
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
 * Reads the name of the sender out of the chat component.
 *
 * prismarine-chat renders a 1.19+ message from the chat type the server sent:
 * the sender is the FIRST entry of the `with` array ("Alice" and the message
 * itself). The `sender` field of the payload is null on 1.21.1, so the
 * component is the only place the name survives when the player list does not
 * know the sender - and without it the whole chat line is dropped.
 *
 * Only the parsed `with` array counts: prismarine-chat builds it from the
 * chat type, so its first entry IS the sender. The raw JSON is not read,
 * because a payload that was never parsed does not prove the parameter order.
 */
function readComponentSender(payload: unknown): string | undefined {
  const record = payload as { sender?: unknown; with?: unknown } | undefined;
  if (typeof record !== 'object' || record === null) return undefined;
  const candidates: unknown[] = [
    record.sender,
    Array.isArray(record.with) ? record.with[0] : undefined,
  ];
  for (const candidate of candidates) {
    const name = componentName(candidate);
    if (name !== undefined) return name;
  }
  return undefined;
}

/**
 * The plain name of a chat component.
 *
 * A component is a plain string, an object with a `text` field or a
 * prismarine-chat message that renders itself. The rendered form is preferred
 * over the raw `text` field so that the name matches the prefix the server
 * renders into the line ("<Alice> hello").
 */
function componentName(component: unknown): string | undefined {
  if (typeof component === 'string') return usableName(component);
  if (typeof component !== 'object' || component === null) return undefined;
  const record = component as { text?: unknown; toString?: () => string };
  if (typeof record.toString === 'function' && record.toString !== Object.prototype.toString) {
    let rendered = '';
    try {
      rendered = record.toString();
    } catch {
      rendered = '';
    }
    const name = usableName(rendered.replace(/^<|>$/g, ''));
    if (name !== undefined) return name;
  }
  if (typeof record.text === 'string') return usableName(record.text);
  return undefined;
}

/** A name is only usable when it is neither empty nor raw JSON. */
function usableName(value: string): string | undefined {
  const name = value.trim();
  if (name.length === 0) return undefined;
  if (name.startsWith('{')) return undefined;
  return name;
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
  const component = readComponentSender(payload);
  if (component !== undefined) return component;

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
  const criticalHunger = options.criticalHunger ?? 6;

  const onMessage = (message: unknown, position: string, senderName?: unknown): void => {
    // System and action bar lines are not chat from a player: they carry no
    // sender and their own component may hold a "with" array, so they must
    // never be mistaken for a message of a player.
    if (position === 'system' || position === 'game_info') return;
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
    try {
      options.onDeath?.();
    } catch (error) {
      log.error('death handler threw', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onHealth = (): void => {
    if ((bot.health ?? 20) <= criticalHealth) {
      try {
        options.onCritical?.('health', bot.health ?? 0);
      } catch (error) {
        log.error('critical health handler threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // The hunger bar is sent in the same packet as the health, so the same
    // event carries it.
    if ((bot.food ?? 20) <= criticalHunger) {
      try {
        options.onCritical?.('hunger', bot.food ?? 0);
      } catch (error) {
        log.error('critical hunger handler threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
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