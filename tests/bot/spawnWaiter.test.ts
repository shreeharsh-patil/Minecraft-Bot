/**
 * The spawn waiter decides whether the bot ever comes online. It must reject
 * exactly once, on every failure path, and it must not leave listeners behind
 * that would later throw (an EventEmitter 'error' without a listener throws).
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { waitForSpawn } from '../../src/bot/createBot.js';
import { silentLogger } from '../../src/utils/logger.js';

/** The bits of the mineflayer bot the spawn waiter touches. */
class FakeBot extends EventEmitter {
  public quit(reason: string): void {
    void reason;
  }
}

describe('spawn waiter', () => {
  it('resolves when the bot spawns', async () => {
    const bot = new FakeBot();
    const waiting = waitForSpawn(bot as never, silentLogger, 1_000);
    bot.emit('spawn');
    await expect(waiting).resolves.toBeUndefined();
  });

  it('rejects on a connection error', async () => {
    const bot = new FakeBot();
    const waiting = waitForSpawn(bot as never, silentLogger, 1_000);
    bot.emit('error', new Error('ECONNREFUSED'));
    await expect(waiting).rejects.toThrow(/connection error: ECONNREFUSED/);
  });

  it('rejects on a kick while connecting', async () => {
    const bot = new FakeBot();
    const waiting = waitForSpawn(bot as never, silentLogger, 1_000);
    bot.emit('kicked', 'You are not whitelisted');
    await expect(waiting).rejects.toThrow(/kicked while connecting/);
  });

  it('rejects when the server never completes the handshake', async () => {
    const bot = new FakeBot();
    await expect(waitForSpawn(bot as never, silentLogger, 20)).rejects.toThrow(/timed out/);
  });

  it('leaves no listeners behind after a timeout', async () => {
    const bot = new FakeBot();
    await expect(waitForSpawn(bot as never, silentLogger, 20)).rejects.toThrow(/timed out/);
    expect(bot.listenerCount('spawn')).toBe(0);
    expect(bot.listenerCount('error')).toBe(0);
    expect(bot.listenerCount('kicked')).toBe(0);
  });

  it('ignores a late spawn after the timeout', async () => {
    const bot = new FakeBot();
    await expect(waitForSpawn(bot as never, silentLogger, 20)).rejects.toThrow(/timed out/);
    expect(() => bot.emit('spawn')).not.toThrow();
  });
});
