/**
 * Audit of the application entry point (src/index.ts).
 *
 * The entry point owns the lifecycle: configuration, the connect/reconnect
 * loop, the natural-language request path and the shutdown. A real Minecraft
 * server is not needed for any of that - only the mineflayer client is - so
 * the client is faked here and the app is driven exactly like the process
 * entry point drives it.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type * as BotEvents from '../../src/bot/events.js';

const mocks = vi.hoisted(() => ({
  /** Stands in for `createBot` - the only part that needs a server. */
  createBot: vi.fn(),
  /** When set, the connection is dropped at the moment the session is wired. */
  dropOnWire: null as { emit: (event: string, reason: string) => boolean } | null,
}));

vi.mock('../../src/bot/createBot.js', () => ({
  createBot: mocks.createBot,
}));

vi.mock('../../src/bot/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BotEvents>();
  return {
    ...actual,
    wireBotEvents: (options: Parameters<typeof actual.wireBotEvents>[0]) => {
      // Simulates the server dropping the connection in the window between
      // the spawn and the moment the disconnect handler is attached: at that
      // point the 'end' event reaches nobody at all.
      if (mocks.dropOnWire !== null && mocks.dropOnWire === options.bot) {
        mocks.dropOnWire = null;
        options.bot.emit('end', 'server closed the connection');
      }
      return actual.wireBotEvents(options);
    },
  };
});

import { BotApp } from '../../src/index.js';

/** The parts of a mineflayer client the entry point actually touches. */
class FakeBot extends EventEmitter {
  public username = 'TestBot';
  public health = 20;
  public food = 20;
  public entity: { position: { x: number; y: number; z: number } } | undefined = undefined;
  public readonly chatMessages: string[] = [];
  public readonly quitReasons: string[] = [];
  /** Makes the teardown throw, to exercise the failure paths. */
  public explodeOnDetach = false;

  chat(message: string): void {
    this.chatMessages.push(message);
  }

  quit(reason?: string): void {
    this.quitReasons.push(reason ?? '');
  }

  override removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    if (this.explodeOnDetach && event === 'message') {
      throw new Error('teardown exploded');
    }
    return super.removeListener(event, listener);
  }
}

const baseEnv: NodeJS.ProcessEnv = {
  MC_HOST: 'localhost',
  MC_PORT: '25565',
  MC_USERNAME: 'TestBot',
  MC_AUTH: 'offline',
  AUTHORIZED_PLAYERS: 'Alice',
  AI_PROVIDER_PRIORITY: 'groq',
  AI_LOCAL_PLANNER: 'true',
  LOG_LEVEL: 'silent',
  DISCONNECT_WITHOUT_HUMANS: 'false',
  MAX_RECONNECT_ATTEMPTS: '2',
  RECONNECT_BASE_DELAY_MS: '100',
};

/** Lets the microtask and timer queues drain. */
function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('app entry point: lifecycle', () => {
  beforeEach(() => {
    mocks.createBot.mockReset();
    mocks.dropOnWire = null;
  });

  it('releases a session that arrives after the app was told to shut down', async () => {
    const bot = new FakeBot();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.createBot.mockImplementation(async () => {
      await gate;
      return { bot, movements: {} };
    });

    const app = await BotApp.create(baseEnv);
    const starting = app.start();

    // The shutdown lands while the connection is still being established -
    // exactly what a SIGTERM during the (slow) spawn wait does.
    await app.shutdown('SIGTERM');
    release?.();

    // An intentional stop is not a fatal startup error.
    await expect(starting).resolves.toBeUndefined();

    // The bot must not stay connected behind the app's back: the socket
    // would keep the process alive on a host that is already tearing the
    // service down.
    expect(bot.quitReasons).toContain('shutting down');
  });

  it('retries when the server drops the connection while the session is being built', async () => {
    const dead = new FakeBot();
    const live = new FakeBot();
    mocks.createBot
      .mockImplementationOnce(() => Promise.resolve({ bot: dead, movements: {} }))
      .mockImplementationOnce(() => Promise.resolve({ bot: live, movements: {} }));
    // The connection dies exactly while the session is wired up.
    mocks.dropOnWire = dead;

    const app = await BotApp.create(baseEnv);
    await app.start();

    // The dead session must not be reported as ready: the app retried.
    expect(mocks.createBot).toHaveBeenCalledTimes(2);
    // ... and the dead client was released.
    expect(dead.quitReasons.length).toBeGreaterThan(0);

    await app.shutdown('test');
  });

  it('never lets a failing shutdown escape as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const bot = new FakeBot();
      mocks.createBot.mockResolvedValue({ bot, movements: {} });
      const app = await BotApp.create(baseEnv);
      await app.start();

      // The teardown blows up while the event listeners are removed.
      bot.explodeOnDetach = true;

      // A fatal disconnect shuts the app down from a fire-and-forget handler.
      bot.emit('end', 'You are not whitelisted on this server!');
      await settle();

      // An unhandled rejection would kill the process (Node's default) - the
      // bot must be able to finish its shutdown instead.
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('releases the housekeeping timer when the app shuts down', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      const bot = new FakeBot();
      mocks.createBot.mockResolvedValue({ bot, movements: {} });
      const app = await BotApp.create(baseEnv);
      await app.start();

      // The housekeeping timer belongs to the app.
      expect(setSpy).toHaveBeenCalled();

      await app.shutdown('test');

      // ... and it is released again.
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('makes every shutdown caller wait for the same shutdown', async () => {
    const bot = new FakeBot();
    mocks.createBot.mockResolvedValue({ bot, movements: {} });
    const app = await BotApp.create(baseEnv);
    await app.start();

    await Promise.all([app.shutdown('first'), app.shutdown('second')]);

    // The client is quit exactly once, by the shutdown that ran.
    expect(bot.quitReasons).toEqual(['first']);
  });
});
