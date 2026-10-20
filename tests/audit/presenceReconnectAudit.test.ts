/**
 * Audit regression tests for the Aternos safe-mode monitor and the bounded
 * reconnect loop.
 *
 * Each "regression" block below failed against the code as it was before the
 * fixes:
 *  - the presence monitor decided who was online from a SPATIAL scan, so it
 *    hung up on an owner who was online but out of range (or whose entity had
 *    not been spawned yet);
 *  - a monitor that was never started fired an instant timeout instead of
 *    honouring HUMAN_TIMEOUT_SECONDS;
 *  - the reconnect loop ignored an abort that arrived while it was connecting;
 *  - a failing post-reconnect hook was treated as a failed connection, so the
 *    loop opened a SECOND session;
 *  - the injected jitter could produce a zero/negative delay or a delay
 *    above maxDelayMs.
 *
 * The "guard" blocks pin behaviour that must not regress while fixing those.
 */
import { describe, expect, it, vi } from 'vitest';
import { HumanPresenceMonitor, type PresenceReason } from '../../src/bot/humanPresence.js';
import { reconnect } from '../../src/bot/reconnect.js';
import type { PresenceConfig } from '../../src/config/config.js';
import type { MinecraftFacade } from '../../src/types/facade.js';
import type { PlayerSummary } from '../../src/types/world.js';
import { silentLogger } from '../../src/utils/logger.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';

/** A facade that only knows spatial visibility - no tab list. */
class SpatialFacade extends FakeMinecraftFacade {
  /** Names the client can currently see. */
  public visible: string[] = [];
  /** Number of presence queries served. */
  public checks = 0;
  /** Radius the last spatial scan asked for. */
  public lastRadius = 0;

  public override getNearbyPlayers(maxDistance: number): PlayerSummary[] {
    this.checks += 1;
    this.lastRadius = maxDistance;
    return this.visible.map((name) => ({
      name,
      distance: 1,
      position: { x: 0, y: 64, z: 0 },
      authorized: true,
    }));
  }
}

/** A facade that can also report the server's tab list (who is ONLINE). */
class TabListFacade extends SpatialFacade {
  /** Names the server reports as online, wherever they are. */
  public online: string[] = [];

  public getOnlinePlayers(): { name: string }[] {
    this.checks += 1;
    return this.online.map((name) => ({ name }));
  }
}

const CONFIG: PresenceConfig = { enabled: true, timeoutSeconds: 60 };

const isAlice = (name: string): boolean => name.toLowerCase() === 'alice';

function monitorFor(
  facade: MinecraftFacade,
  isAuthorized: (name: string) => boolean = isAlice,
): { monitor: HumanPresenceMonitor; disconnects: PresenceReason[] } {
  const disconnects: PresenceReason[] = [];
  const monitor = new HumanPresenceMonitor(CONFIG, facade, isAuthorized, silentLogger);
  monitor.setDisconnectHandler((reason) => disconnects.push(reason));
  return { monitor, disconnects };
}

describe('HumanPresenceMonitor - who counts as online', () => {
  it('keeps the session alive while an authorized human is online but out of range', () => {
    // The owner is on the server (tab list) but far away, so no player
    // entity is in range. A spatial scan alone reports an empty server and
    // the bot hangs up on somebody who is online.
    const facade = new TabListFacade();
    facade.online = ['Alice'];
    const { monitor, disconnects } = monitorFor(facade);
    monitor.start();

    const verdict = monitor.check(Date.now() + 5 * 60_000);

    expect(verdict.shouldStay).toBe(true);
    expect(verdict.reason).toBe('authorized-human-present');
    expect(disconnects).toEqual([]);
  });

  it('still disconnects when only unauthorized players are online', () => {
    const facade = new TabListFacade();
    facade.online = ['Mallory'];
    const { monitor, disconnects } = monitorFor(facade);
    monitor.start();

    const verdict = monitor.check(Date.now() + 5 * 60_000);

    expect(verdict.shouldStay).toBe(false);
    expect(verdict.reason).toBe('timeout');
    expect(disconnects).toEqual(['timeout']);
  });

  it('still disconnects when nobody is online at all', () => {
    const facade = new TabListFacade();
    const { monitor, disconnects } = monitorFor(facade, () => false);
    monitor.start();

    const verdict = monitor.check(Date.now() + 5 * 60_000);

    expect(verdict.shouldStay).toBe(false);
    expect(disconnects).toEqual(['timeout']);
  });

  it('never counts the bot itself as a human', () => {
    const facade = new TabListFacade();
    facade.online = [facade.username];
    const { monitor, disconnects } = monitorFor(facade, (name) => name.toLowerCase() === 'testbot');
    monitor.start();

    const verdict = monitor.check(Date.now() + 5 * 60_000);

    expect(verdict.shouldStay).toBe(false);
    expect(disconnects).toEqual(['timeout']);
  });

  it('falls back to the spatial scan when the facade has no tab list', () => {
    const facade = new SpatialFacade();
    facade.visible = ['Alice'];
    const { monitor, disconnects } = monitorFor(facade);
    monitor.start();

    const verdict = monitor.check(Date.now() + 5 * 60_000);

    expect(verdict.shouldStay).toBe(true);
    expect(disconnects).toEqual([]);
  });

  it('does not cut off owners who are online but far away in the fallback scan', () => {
    const facade = new SpatialFacade();
    facade.visible = ['Alice'];
    const { monitor } = monitorFor(facade);
    monitor.start();
    monitor.check(Date.now() + 1_000);

    // The scan must not be limited to a fixed radius: the server only sends
    // the player entities it tracks, and a radius would drop owners who are
    // online but out of range.
    expect(facade.lastRadius).toBeGreaterThan(64);
  });

  it('does not fire an instant timeout when the monitor was never started', () => {
    const facade = new TabListFacade();
    const { monitor, disconnects } = monitorFor(facade, () => false);

    // No start(): there is no reference point yet, so the grace period has to
    // start now instead of the timeout firing on the very first check.
    const verdict = monitor.check(1_000_000);

    expect(verdict.shouldStay).toBe(true);
    expect(disconnects).toEqual([]);

    // ... and the timeout still fires once the grace period has passed.
    const later = monitor.check(1_000_000 + 61_000);

    expect(later.shouldStay).toBe(false);
    expect(later.reason).toBe('timeout');
    expect(disconnects).toEqual(['timeout']);
  });
});

describe('HumanPresenceMonitor - the timer', () => {
  it('stops the timer after the timeout so the disconnect fires only once', async () => {
    vi.useFakeTimers();
    try {
      const facade = new TabListFacade();
      const { monitor, disconnects } = monitorFor(facade, () => false);
      monitor.start();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(disconnects).toEqual(['timeout']);

      const checks = facade.checks;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(facade.checks).toBe(checks);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never runs two presence timers', async () => {
    vi.useFakeTimers();
    try {
      const facade = new TabListFacade();
      const { monitor } = monitorFor(facade, () => false);
      monitor.start();
      monitor.start();

      await vi.advanceTimersByTimeAsync(10_000);
      // One check per PRESENCE_CHECK_MS, not one per timer.
      expect(facade.checks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reconnect - abort handling', () => {
  it('gives up when the shutdown signal fires while connecting', async () => {
    const controller = new AbortController();
    let hooks = 0;

    const outcome = await reconnect({
      logger: silentLogger,
      policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, random: () => 0 },
      connect: () => {
        // SIGTERM arrives while the bot is still joining the server.
        controller.abort();
        return Promise.resolve();
      },
      onReconnected: () => {
        hooks += 1;
      },
      signal: controller.signal,
    });

    expect(outcome).toBe('aborted');
    expect(hooks).toBe(0);
  });

  it('gives up when the shutdown signal fires during the backoff wait', async () => {
    const controller = new AbortController();
    let calls = 0;

    const outcome = await reconnect({
      logger: silentLogger,
      policy: { maxAttempts: 5, baseDelayMs: 50, maxDelayMs: 50, random: () => 0 },
      connect: () => {
        calls += 1;
        controller.abort();
        return Promise.reject(new Error('connection reset'));
      },
      signal: controller.signal,
    });

    expect(outcome).toBe('aborted');
    expect(calls).toBe(1);
  });
});

describe('reconnect - the post-reconnect hook', () => {
  it('does not open a second session when the hook fails', async () => {
    let calls = 0;

    const outcome = await reconnect({
      logger: silentLogger,
      policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, random: () => 0 },
      connect: () => {
        calls += 1;
        return Promise.resolve();
      },
      onReconnected: () => {
        throw new Error('hook exploded');
      },
    });

    expect(outcome).toBe('connected');
    expect(calls).toBe(1);
  });
});

describe('reconnect - the backoff window', () => {
  it('never waits zero or negative milliseconds', async () => {
    const delays: number[] = [];

    const outcome = await reconnect({
      logger: silentLogger,
      policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, random: () => -3 },
      connect: () => Promise.reject(new Error('connection refused')),
      onRetry: (_attempt, delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(outcome).toBe('exhausted');
    expect(delays).toHaveLength(3);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(1);
    }
  });

  it('never waits longer than maxDelayMs', async () => {
    const delays: number[] = [];

    await reconnect({
      logger: silentLogger,
      policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500, random: () => 5 },
      connect: () => Promise.reject(new Error('connection refused')),
      onRetry: (_attempt, delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(delays).toHaveLength(3);
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(500);
    }
  });

  it('grows the backoff and stops at the attempt budget', async () => {
    const delays: number[] = [];
    let calls = 0;

    const outcome = await reconnect({
      logger: silentLogger,
      policy: { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 1000, random: () => 1 },
      connect: () => {
        calls += 1;
        return Promise.reject(new Error('connection refused'));
      },
      onRetry: (_attempt, delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(outcome).toBe('exhausted');
    expect(calls).toBe(4);
    expect(delays).toEqual([10, 20, 40, 80]);
  });
});
