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

describe('wireBotEvents - chat payloads', () => {
  it('reads the modern prismarine-chat payload with the sender as an argument', () => {
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    emit('message', chatMessage('hello bot'), 'chat', 'Alice', true);

    expect(onChat).toHaveBeenCalledWith('Alice', 'hello bot');
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
