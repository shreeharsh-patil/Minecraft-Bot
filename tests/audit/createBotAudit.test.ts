/**
 * `createBot` owns the connection: it must fail fast when the server drops
 * the handshake and it must never leave a half-open socket behind.
 *
 * Both are checked against a fake client because the real one needs a live
 * server: the fake bot deliberately has no `quit` method, exactly like a
 * mineflayer bot whose handshake never completed (mineflayer defines `quit`
 * in its kick plugin, which is injected after the handshake).
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MinecraftConfig } from '../../src/config/config.js';
import { silentLogger } from '../../src/utils/logger.js';

const state = vi.hoisted(() => ({ bot: null as FakeBot | null }));

vi.mock('mineflayer', () => ({
  default: {
    createBot: () => state.bot,
    oldestSupportedVersion: '1.8.8',
    latestSupportedVersion: '26.1',
    testedVersions: ['1.8.8', '1.21.1', '26.1'],
  },
}));

vi.mock('mineflayer-pathfinder', () => ({
  pathfinder: vi.fn(),
  Movements: class {
    public canDig = true;
    public allow1by1towers = true;
    public allowParkour = true;
    public allowSprinting = true;
    public constructor(public readonly bot: unknown) {}
  },
}));

const { createBot, waitForSpawn } = await import('../../src/bot/createBot.js');

/** A mineflayer bot whose handshake never completed: no `quit` method. */
class FakeBot extends EventEmitter {
  public readonly endCalls: string[] = [];
  public readonly username = 'AuditBot';
  public readonly version = '1.21.1';

  public loadPlugin(): void {
    // The real plugin needs a live registry; nothing to do here.
  }

  public end(reason?: string): void {
    this.endCalls.push(reason ?? '');
  }
}

const config: MinecraftConfig = {
  host: '127.0.0.1',
  port: 25565,
  username: 'AuditBot',
  auth: 'offline',
  spawnTimeoutMs: 1_000,
};

describe('createBot connection handling', () => {
  beforeEach(() => {
    state.bot = new FakeBot();
  });

  it('tears the client down when the connection fails before the handshake', async () => {
    const bot = state.bot as FakeBot;
    const pending = createBot({ config, logger: silentLogger });
    bot.emit('error', new Error('ECONNREFUSED'));

    await expect(pending).rejects.toThrow(/connection error: ECONNREFUSED/);
    // The socket must be closed - `bot.quit` does not exist this early, so the
    // teardown has to go through `bot.end`.
    expect(bot.endCalls).toEqual(['spawn failed']);
  });

  it('rejects when the connection closes before the bot spawns', async () => {
    const bot = new FakeBot();
    const waiting = waitForSpawn(bot as never, silentLogger, 60_000);
    bot.emit('end', 'socketClosed');

    await expect(waiting).rejects.toThrow(/connection closed before spawn: socketClosed/);
  });

  it('leaves no listeners behind after the connection closes', async () => {
    const bot = new FakeBot();
    const waiting = waitForSpawn(bot as never, silentLogger, 60_000);
    bot.emit('end', 'socketClosed');
    await expect(waiting).rejects.toThrow(/connection closed before spawn/);
    expect(bot.listenerCount('spawn')).toBe(0);
    expect(bot.listenerCount('error')).toBe(0);
    expect(bot.listenerCount('kicked')).toBe(0);
    expect(bot.listenerCount('end')).toBe(0);
  });

  it('still spawns and keeps an error listener for the whole session', async () => {
    const bot = state.bot as FakeBot;
    const pending = createBot({ config, logger: silentLogger });
    bot.emit('spawn');

    const connected = await pending;
    expect(connected.bot).toBe(bot);
    // An EventEmitter 'error' event without a listener throws.
    expect(bot.listenerCount('error')).toBe(1);
  });
});
