/**
 * Audit of the mineflayer event wiring (`src/bot/events.ts`).
 *
 * The payload shapes here are the REAL ones a 1.21.1 server produces, built
 * with the very library mineflayer uses (`prismarine-chat`):
 *
 *   bot.emit('message', msg, 'chat', data.sender, verified)
 *
 * where `msg` is a `ChatMessage` whose `sender` field does NOT exist, whose
 * name lives in the first entry of the `with` array and whose `toString()`
 * renders the whole line, sender prefix included ("<Alice> hello bot").
 * `data.sender` is the player's UUID on 1.19+.
 *
 * Everything the bot does with a chat line depends on getting those three
 * things right: who sent it, what was said and that the "<Alice> " prefix is
 * gone. A mistake here does not throw - it silently turns every command into
 * plain chat, so the tests below pin the exact shapes.
 */
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { wireBotEvents } from '../../src/bot/events.js';
import { silentLogger } from '../../src/utils/logger.js';

const require = createRequire(import.meta.url);

/** The part of a prismarine-chat message the wiring looks at. */
interface ChatMessageLike {
  toString: () => string;
  json: unknown;
  with?: unknown[];
}

interface ChatMessageFactory {
  (registry: unknown): {
    fromNetwork: (type: number, params: Record<string, unknown>) => ChatMessageLike;
    fromNotch: (message: string) => ChatMessageLike;
  };
}

// prismarine-chat is CommonJS and ships no type declarations.
const prismarineChat = require('prismarine-chat') as ChatMessageFactory;

/**
 * The chat type a 1.21.1 server uses for a player chat: "<%s> %s" with the
 * sender and the content as parameters.
 */
const registry = {
  language: { 'chat.type.text': '<%s> %s' },
  supportFeature: (): boolean => false,
  chatFormattingById: {
    0: {
      id: 0,
      name: 'minecraft:chat',
      formatString: '<%s> %s',
      parameters: ['sender', 'content'],
    },
  },
};

const ChatMessage = prismarineChat(registry);

/** The UUID the server sends as the chat sender on 1.19+. */
const ALICE_UUID = '10920508-d5d8-3eed-93d2-92f193afe7d7';

/**
 * The payload mineflayer hands to the 'message' listener on 1.21.1.
 *
 * `prismarine-chat` renders the message from the chat type, so the sender is
 * the first entry of the `with` array and the payload has no `sender` field
 * at all.
 */
function realChatPayload(sender: string, text: string): ChatMessageLike {
  return ChatMessage.fromNetwork(0, {
    sender: { text: sender },
    target: undefined,
    content: { text },
  });
}

/**
 * The payload of a pre-1.19 server: the whole chat line arrives as one
 * component ("<Alice> hello bot") and the sender argument is a UUID as well.
 */
function legacyChatPayload(sender: string, text: string): ChatMessageLike {
  return ChatMessage.fromNotch(
    JSON.stringify({ translate: 'chat.type.text', with: [sender, text] }),
  );
}

interface FakeBot {
  bot: never;
  emit: (event: string, ...args: unknown[]) => void;
  /** The values mineflayer keeps on the bot. */
  state: { health: number; food: number };
}

/** A minimal stand-in for the mineflayer bot (only the events we use). */
function fakeBot(playerList?: Record<string, string>): FakeBot {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const state = { health: 20, food: 20 };
  const bot = {
    on: (event: string, handler: (...args: unknown[]) => void): void => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    removeListener: (event: string, handler: (...args: unknown[]) => void): void => {
      const list = handlers.get(event) ?? [];
      handlers.set(event, list.filter((entry) => entry !== handler));
    },
    get health(): number {
      return state.health;
    },
    get food(): number {
      return state.food;
    },
    ...(playerList ? { uuidToUsername: { ...playerList } } : {}),
  };
  return {
    bot: bot as never,
    state,
    emit: (event: string, ...args: unknown[]): void => {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
}

describe('wireBotEvents - the real 1.21.1 chat payload', () => {
  it('reads the sender out of the chat component when the player list is empty', () => {
    // The player list did not (yet) know Alice: the name is still in the
    // chat component, so the line must not be dropped.
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    emit('message', realChatPayload('Alice', 'hello bot'), 'chat', ALICE_UUID, true);

    expect(onChat).toHaveBeenCalledWith('Alice', 'hello bot');
  });

  it('keeps the sender prefix out of the message so commands still work', () => {
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    emit('message', realChatPayload('Alice', '!status'), 'chat', ALICE_UUID, true);

    expect(onChat).toHaveBeenCalledWith('Alice', '!status');
  });

  it('delivers a profileless chat message that has no sender argument', () => {
    // A message the server sends on behalf of a player (no chat session):
    // there is no UUID, the name only exists in the component.
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    emit('message', realChatPayload('Alice', 'hello bot'), 'chat', undefined, false);

    expect(onChat).toHaveBeenCalledWith('Alice', 'hello bot');
  });

  it('never turns a system message into chat', () => {
    // A system message can carry a "with" array of its own ("Alice joined
    // the game"): it must not be mistaken for a message of a player.
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    const system = ChatMessage.fromNetwork(0, {
      sender: { text: 'Alice' },
      content: { text: 'joined the game' },
    });
    emit('message', system, 'system', null, false);

    expect(onChat).not.toHaveBeenCalled();
  });

  it('never turns an action bar line into chat', () => {
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    emit('message', realChatPayload('Alice', 'hello bot'), 'game_info', null, false);

    expect(onChat).not.toHaveBeenCalled();
  });

  it('falls back to the player list when the component carries no name', () => {
    const { bot, emit } = fakeBot({ [ALICE_UUID]: 'Alice' });
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    // An empty component renders to "[object Object]", which is not a name.
    const payload: ChatMessageLike = {
      toString: () => '<Alice> hello bot',
      json: { translate: '<%s> %s', with: [{}, { text: 'hello bot' }] },
      with: [{}, { text: 'hello bot' }],
    };
    emit('message', payload, 'chat', ALICE_UUID, true);

    expect(onChat).toHaveBeenCalledWith('Alice', 'hello bot');
  });

  it('drops a line whose sender cannot be resolved at all', () => {
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    // No component, no player list entry: nobody to attribute the line to.
    emit('message', { toString: () => 'hello bot' }, 'chat', ALICE_UUID, true);

    expect(onChat).not.toHaveBeenCalled();
  });

  it('reads a pre-1.19 chat line the same way', () => {
    // A 1.8 - 1.18 server sends the whole line as one component and the
    // sender as a UUID.
    const { bot, emit } = fakeBot();
    const onChat = vi.fn();
    wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

    emit('message', legacyChatPayload('Alice', '!status'), 'chat', ALICE_UUID, false);

    expect(onChat).toHaveBeenCalledWith('Alice', '!status');
  });
});

describe('wireBotEvents - the optional handlers are guarded', () => {
  it('does not let a throwing death handler escape into the event loop', () => {
    const { bot, emit } = fakeBot();
    wireBotEvents({
      bot,
      logger: silentLogger,
      onChat: vi.fn(),
      onDisconnect: vi.fn(),
      onDeath: () => {
        throw new Error('boom');
      },
    });

    expect(() => emit('death')).not.toThrow();
  });

  it('does not let a throwing critical handler escape into the event loop', () => {
    const { bot, emit, state } = fakeBot();
    state.health = 2;
    wireBotEvents({
      bot,
      logger: silentLogger,
      onChat: vi.fn(),
      onDisconnect: vi.fn(),
      onCritical: () => {
        throw new Error('boom');
      },
    });

    expect(() => emit('health')).not.toThrow();
  });

  it('reports a starving bot through the hunger threshold', () => {
    const { bot, emit, state } = fakeBot();
    state.food = 3;
    const onCritical = vi.fn();
    wireBotEvents({
      bot,
      logger: silentLogger,
      onChat: vi.fn(),
      onDisconnect: vi.fn(),
      criticalHunger: 6,
      onCritical,
    });

    emit('health');

    expect(onCritical).toHaveBeenCalledWith('hunger', 3);
  });

  it('reports a hurt bot through the health threshold', () => {
    const { bot, emit, state } = fakeBot();
    state.health = 4;
    const onCritical = vi.fn();
    wireBotEvents({
      bot,
      logger: silentLogger,
      onChat: vi.fn(),
      onDisconnect: vi.fn(),
      criticalHealth: 6,
      onCritical,
    });

    emit('health');

    expect(onCritical).toHaveBeenCalledWith('health', 4);
  });
});
