/**
 * Chat delivery is the bot's front door: if the payload is misread, every
 * command, reply and `!stop` is dead while the bot looks perfectly healthy.
 *
 * mineflayer 4.35+ emits `bot.emit('message', msg, 'chat', data.sender, verified)`
 * where `msg` is a prismarine-chat ChatMessage - an object with no `username`
 * and no `message` field. Older servers emit a JSON string instead. Both must
 * work.
 */
import { describe, expect, it, vi } from 'vitest';
import { wireBotEvents } from '../../src/bot/events.js';
import { silentLogger } from '../../src/utils/logger.js';

/** A minimal stand-in for the mineflayer bot (only the events we use). */
function fakeBot(): {
  bot: never;
  emit: (event: string, ...args: unknown[]) => void;
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    bot: {
      on: (event: string, handler: (...args: unknown[]) => void): void => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      removeListener: (event: string, handler: (...args: unknown[]) => void): void => {
        const list = handlers.get(event) ?? [];
        handlers.set(event, list.filter((entry) => entry !== handler));
      },
      health: 20,
    } as never,
    emit: (event: string, ...args: unknown[]): void => {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
}

/** What prismarine-chat hands to the listener. */
function chatMessage(text: string): { toString: () => string; json: unknown } {
  return {
    toString: () => text,
    json: { translate: 'chat.type.text', with: ['Alice', text] },
  };
}

/**
 * The REAL 1.19+ payload: the sender argument is a UUID, and the name lives
 * in the chat component and in the player list. Reading the UUID as a name
 * made the bot mute on 1.21.1 (it never matched AUTHORIZED_PLAYERS).
 */
function modernChatMessage(text: string, name = 'Alice'): {
  toString: () => string;
  sender: { toString: () => string };
  json: unknown;
} {
  return {
    toString: () => text,
    sender: { toString: () => `<${name}>` },
    json: { translate: 'chat.type.text', with: [name, text] },
  };
}

const ALICE_UUID = '10920508-d5d8-3eed-93d2-92f193afe7d7';

describe('wireBotEvents - chat payloads', () => {
  it('reads the modern prismarine-chat payload with the sender as an argument', () => {
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    emit('message', chatMessage('hello bot'), 'chat', 'Alice', true);

    expect(onChat).toHaveBeenCalledWith('Alice', 'hello bot');
  });

  it('resolves the name from the chat component on 1.19+ (UUID sender)', () => {
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    emit('message', modernChatMessage('hello bot'), 'chat', ALICE_UUID, true);

    expect(onChat).toHaveBeenCalledWith('Alice', 'hello bot');
  });

  it('resolves the name from the player list when the component is missing', () => {
    const { bot, emit } = fakeBot();
    (bot as unknown as { uuidToUsername: Record<string, string> }).uuidToUsername = {
      [ALICE_UUID]: 'Alice',
    };
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    // A payload without a sender component (older clientside formatting).
    emit('message', { toString: () => 'hello bot' }, 'chat', ALICE_UUID, true);

    expect(onChat).toHaveBeenCalledWith('Alice', 'hello bot');
  });

  it('strips the sender prefix the server renders into the line', () => {
    const { bot, emit } = fakeBot();
    (bot as unknown as { uuidToUsername: Record<string, string> }).uuidToUsername = {
      [ALICE_UUID]: 'Alice',
    };
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    // The real 1.19+ payload renders as "<Alice> !status".
    emit('message', { toString: () => '<Alice> !status' }, 'chat', ALICE_UUID, true);

    expect(onChat).toHaveBeenCalledWith('Alice', '!status');
  });

  it('keeps a command prefix intact after stripping the sender', () => {
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    emit('message', chatMessage('<Alice> !stop'), 'chat', 'Alice', true);

    expect(onChat).toHaveBeenCalledWith('Alice', '!stop');
  });

  it('ignores an unknown UUID instead of treating it as a name', () => {
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    emit('message', { toString: () => 'hello bot' }, 'chat', ALICE_UUID, true);

    expect(onChat).not.toHaveBeenCalled();
  });

  it('still reads the legacy JSON payload', () => {
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    emit('message', JSON.stringify({ username: 'Bob', message: 'hi there' }), 'chat');

    expect(onChat).toHaveBeenCalledWith('Bob', 'hi there');
  });

  it('ignores system messages that have no sender', () => {
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    emit('message', chatMessage('Server closed'), 'system', undefined, false);

    expect(onChat).not.toHaveBeenCalled();
  });

  it('survives a payload that is neither shape', () => {
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    emit('message', { nonsense: true }, 'chat', 'Alice', true);
    emit('message', 'not json', 'chat');

    expect(onChat).not.toHaveBeenCalled();
  });

  it('detaches its listeners on teardown', () => {
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    const detach = wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });
    detach();

    emit('message', chatMessage('after detach'), 'chat', 'Alice', true);

    expect(onChat).not.toHaveBeenCalled();
  });
});
