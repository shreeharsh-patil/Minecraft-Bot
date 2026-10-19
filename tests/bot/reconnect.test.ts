/**
 * Reconnection policy: bounded backoff, fatal-kick detection.
 *
 * These are the guarantees Aternos relies on: a server restart (or transient
 * drop) must be retried within the attempt budget, while whitelist/ban/auth
 * kicks must stop immediately instead of burning every attempt.
 */
import { describe, expect, it } from 'vitest';
import { reconnect, isFatalDisconnect, policyFrom, type ReconnectPolicy } from '../../src/bot/reconnect.js';
import { silentLogger } from '../../src/utils/logger.js';

/** Deterministic delays: random() = 1 -> full exponential delay. */
const policy = (maxAttempts = 3, baseDelayMs = 1): ReconnectPolicy => ({
  ...policyFrom(maxAttempts, baseDelayMs, 1),
  random: () => 1,
});

describe('isFatalDisconnect', () => {
  it('treats whitelist, ban, auth and version kicks as permanent', () => {
    expect(isFatalDisconnect('You are not whitelisted on this server!')).toBe(true);
    expect(isFatalDisconnect('You are banned from this server')).toBe(true);
    expect(isFatalDisconnect('multiplayer.disconnect.banned')).toBe(true);
    expect(isFatalDisconnect('Invalid session (authentication failed)')).toBe(true);
    expect(isFatalDisconnect('Outdated server! I\'m still on 1.20.4')).toBe(true);
    expect(isFatalDisconnect('Server is full')).toBe(true);
  });

  it('treats a normal server shutdown/restart as retryable (Aternos restarts)', () => {
    expect(isFatalDisconnect('multiplayer.disconnect.server_shutdown')).toBe(false);
    expect(isFatalDisconnect('Server closed')).toBe(false);
    expect(isFatalDisconnect('Connection reset')).toBe(false);
    expect(isFatalDisconnect('kicked: {"text":"Server closed"}')).toBe(false);
    expect(isFatalDisconnect('connection error: connect ECONNREFUSED')).toBe(false);
  });
});

describe('reconnect', () => {
  it('connects on the first attempt without giving up', async () => {
    let calls = 0;
    const outcome = await reconnect({
      logger: silentLogger,
      policy: policy(),
      connect: () => {
        calls += 1;
        return Promise.resolve();
      },
    });

    expect(outcome).toBe('connected');
    expect(calls).toBe(1);
  });

  it('retries transient failures and eventually connects', async () => {
    let calls = 0;
    const outcome = await reconnect({
      logger: silentLogger,
      policy: policy(5),
      connect: () => {
        calls += 1;
        if (calls < 3) return Promise.reject(new Error('Connection reset'));
        return Promise.resolve();
      },
    });

    expect(outcome).toBe('connected');
    expect(calls).toBe(3);
  });

  it('stops after MAX_RECONNECT_ATTEMPTS instead of looping forever', async () => {
    let calls = 0;
    const outcome = await reconnect({
      logger: silentLogger,
      policy: policy(4),
      connect: () => {
        calls += 1;
        return Promise.reject(new Error('Connection refused'));
      },
    });

    expect(outcome).toBe('exhausted');
    expect(calls).toBe(4);
  });

  it('never retries a fatal kick', async () => {
    let calls = 0;
    const outcome = await reconnect({
      logger: silentLogger,
      policy: policy(5),
      connect: () => {
        calls += 1;
        return Promise.reject(new Error('kicked while connecting: You are not whitelisted'));
      },
    });

    expect(outcome).toBe('fatal');
    expect(calls).toBe(1);
  });

  it('returns immediately when the policy disables reconnecting', async () => {
    let calls = 0;
    const outcome = await reconnect({
      logger: silentLogger,
      policy: policy(0),
      connect: () => {
        calls += 1;
        return Promise.resolve();
      },
    });

    expect(outcome).toBe('exhausted');
    expect(calls).toBe(0);
  });

  it('aborts between attempts when the signal fires (shutdown during wait)', async () => {
    const controller = new AbortController();
    let calls = 0;
    const outcome = await reconnect({
      logger: silentLogger,
      policy: policy(5, 50),
      connect: () => {
        calls += 1;
        // Abort while the loop is about to sleep for the next attempt.
        controller.abort();
        return Promise.reject(new Error('Connection reset'));
      },
      signal: controller.signal,
    });

    expect(outcome).toBe('aborted');
    expect(calls).toBe(1);
  });
});
