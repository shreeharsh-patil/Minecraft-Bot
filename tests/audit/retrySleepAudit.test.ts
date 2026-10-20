/**
 * Audit of the timing helpers: cancellable sleep, timeout racing, retry.
 *
 * Every timed operation in the bot funnels through these three helpers, so a
 * defect here is either a dead process (a floating rejection takes Node down
 * with it) or a bot that gives up on - or hangs past - something that
 * actually worked.
 */
import { describe, expect, it } from 'vitest';
import { AbortedError, sleep, waitUntil, withTimeout } from '../../src/utils/sleep.js';
import { retry } from '../../src/utils/retry.js';

describe('withTimeout', () => {
  it('never leaves the work promise unhandled when the signal is already aborted', async () => {
    const unhandled: unknown[] = [];
    const capture = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', capture);
    try {
      const controller = new AbortController();
      controller.abort();
      // The work fails *after* withTimeout walked away from it - a floating
      // rejection that Node turns into a process crash.
      const work = new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late failure')), 10);
      });

      await expect(withTimeout(work, 1_000, 'operation', controller.signal)).rejects.toBeInstanceOf(AbortedError);

      // Give the abandoned work promise time to fail.
      await sleep(60);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', capture);
    }
  });

  it('still reports a timeout when the work never settles', async () => {
    const never = new Promise<string>(() => undefined);
    await expect(withTimeout(never, 30, 'operation')).rejects.toThrow(/operation timed out after 30ms/);
  });
});

describe('waitUntil', () => {
  it('does not sleep past the deadline it was given', async () => {
    const started = Date.now();
    await expect(waitUntil(() => false, { timeoutMs: 60, intervalMs: 500 })).rejects.toThrow(/Timed out/);
    // The poll interval must not stretch the caller's timeout.
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('resolves when the condition becomes true during the last poll', async () => {
    let ready = false;
    const flip = setTimeout(() => {
      ready = true;
    }, 30);
    try {
      await expect(waitUntil(() => ready, { timeoutMs: 150, intervalMs: 150 })).resolves.toBeUndefined();
    } finally {
      clearTimeout(flip);
    }
  });
});

describe('retry', () => {
  it('does not start an attempt when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    await expect(
      retry(() => {
        calls += 1;
        return Promise.resolve('done');
      }, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortedError);
    expect(calls).toBe(0);
  });

  it('reports the abort instead of the work error when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      retry(() => Promise.reject(new Error('work failed')), { attempts: 1, signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortedError);
  });

  it('rejects with the original error when the attempt count is not a number', async () => {
    const failure = new Error('boom');

    await expect(
      retry(() => Promise.reject(failure), { attempts: Number.NaN, baseDelayMs: 1 }),
    ).rejects.toBe(failure);
  });

  it('never retries forever when the attempt count is not finite', async () => {
    const controller = new AbortController();
    // The abort is only a safety net: a correct implementation gives up long
    // before it fires.
    const stop = setTimeout(() => controller.abort(), 200);
    let calls = 0;
    try {
      await expect(
        retry(() => {
          calls += 1;
          return Promise.reject(new Error('boom'));
        }, { attempts: Number.POSITIVE_INFINITY, baseDelayMs: 1, signal: controller.signal }),
      ).rejects.toThrow('boom');
    } finally {
      clearTimeout(stop);
    }
    expect(calls).toBeLessThanOrEqual(10);
  });

  it('backs off with a growing delay that stays inside the cap', async () => {
    const delays: number[] = [];

    await expect(
      retry(() => Promise.reject(new Error('boom')), {
        attempts: 4,
        baseDelayMs: 1,
        maxDelayMs: 4,
        random: () => 1,
        onRetry: (_error, _attempt, delayMs) => {
          delays.push(delayMs);
        },
      }),
    ).rejects.toThrow('boom');

    expect(delays).toHaveLength(3);
    expect(delays[0]).toBe(1);
    expect(delays[1]).toBe(2);
    expect(delays[2]).toBe(4);
    for (const delay of delays) {
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(4);
    }
  });
});
