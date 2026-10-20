/**
 * Audit tests for `src/ai/AIManager.ts` - the concurrency manager around the
 * planner (queueing, cancellation, provider routing, stats, degradation).
 *
 * Every test here is a regression test: it fails against the unfixed manager
 * and passes once the defect is repaired.
 */
import { describe, expect, it } from 'vitest';
import { AIManager } from '../../src/ai/AIManager.js';
import type { AiConfig } from '../../src/config/config.js';
import type { CompactContext } from '../../src/ai/contextBuilder.js';
import type { AiProvider, CompletionRequest, CompletionResult } from '../../src/types/provider.js';

const baseConfig: AiConfig = {
  providers: [{ name: 'groq', apiKey: 'test-key', model: 'test-model' }],
  localPlanner: false,
  requestTimeoutMs: 2_000,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 1_000,
  maxConcurrentRequests: 1,
};

const context: CompactContext = {
  position: { x: 0, y: 64, z: 0 },
  dimension: 'overworld',
  timeOfDay: 'day',
  health: { current: 20, max: 20 },
  hunger: { current: 20, saturation: 5 },
  task: null,
  targetPlayer: null,
  nearbyPlayers: [{ name: 'Alice', distance: 3, authorized: true, health: 20 }],
  nearbyHostiles: [],
  nearbyBlocks: [],
  dangerousBlocksNearby: [],
  inventory: { held: null, usedSlots: 0, freeSlots: 36, items: [] },
  recentChat: [],
};

/**
 * A provider that answers slowly and honours the abort signal: the request
 * is only completed if nobody cancelled it.
 */
function slowProvider(delayMs = 50): AiProvider & { calls: number } {
  const provider = {
    name: 'groq' as const,
    model: 'test-model',
    calls: 0,
    isAvailable: () => true,
    healthCheck: () => Promise.resolve(true),
    complete: (req: CompletionRequest) =>
      new Promise<CompletionResult>((resolve, reject) => {
        provider.calls += 1;
        const timer = setTimeout(
          () => resolve({ text: '{"actions":[]}', latencyMs: delayMs, model: 'test-model' }),
          delayMs,
        );
        req.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
    dispose: () => undefined,
  };
  return provider;
}

/** A provider that never answers until it is aborted. */
function hangingProvider(): AiProvider {
  return {
    name: 'groq',
    model: 'test-model',
    isAvailable: () => true,
    healthCheck: () => Promise.resolve(true),
    complete: (req: CompletionRequest) =>
      new Promise<CompletionResult>((_resolve, reject) => {
        req.signal?.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
    dispose: () => undefined,
  };
}

describe('AIManager audit - manager-wide cancellation', () => {
  it('honours a cancelAll() issued in the same tick as the request', async () => {
    const provider = slowProvider();
    const manager = new AIManager({ config: baseConfig, providers: [provider] });

    // The request enters the manager; `!stop` arrives before the first
    // microtask of the request chain has run.
    const promise = manager.plan({
      instruction: 'follow me',
      requester: 'Alice',
      context,
    });
    const cancelled = manager.cancelAll('stop');

    expect(cancelled).toBe(1);
    // The abort must reach the provider layer: no API request may be issued
    // for a plan that `!stop` already counted as cancelled.
    await expect(promise).resolves.toEqual([]);
    expect(provider.calls).toBe(0);

    await manager.dispose();
  });

  it('still aborts a plan that is already talking to the provider', async () => {
    const manager = new AIManager({ config: baseConfig, providers: [hangingProvider()] });

    const promise = manager.plan({ instruction: 'follow me', requester: 'Alice', context });
    // Let the request reach the provider before `!stop` arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(manager.cancelAll('stop')).toBe(1);
    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });

    await manager.dispose();
  });

  it('counts a queued request dropped by cancelAll() as rejected', async () => {
    const manager = new AIManager({ config: baseConfig, providers: [hangingProvider()] });

    const first = manager.plan({ instruction: 'a', requester: 'Alice', context });
    const second = manager.plan({ instruction: 'b', requester: 'Alice', context });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(manager.stats().queued).toBe(1);
    expect(manager.cancelAll('stop')).toBe(2);
    // The queued request never reached a provider: it was rejected.
    expect(manager.stats().rejected).toBe(1);

    await expect(first).rejects.toBeDefined();
    await expect(second).rejects.toBeDefined();
    await manager.dispose();
  });
});

describe('AIManager audit - configuration guards', () => {
  it('keeps serving requests when maxConcurrentRequests is not a finite number', async () => {
    const provider = slowProvider(5);
    const manager = new AIManager({
      config: { ...baseConfig, maxConcurrentRequests: Number.NaN },
      providers: [provider],
    });

    // A NaN limit made `inFlight < maxConcurrent` false for every value, so
    // every request was queued and timed out instead of being planned.
    const result = await manager.plan({ instruction: 'follow me', requester: 'Alice', context });
    expect(result).toEqual([]);
    expect(provider.calls).toBe(1);

    await manager.dispose();
  });

  it('keeps the concurrency bound when maxConcurrentRequests is Infinity', async () => {
    let inProvider = 0;
    let peak = 0;
    const provider: AiProvider = {
      name: 'groq',
      model: 'test-model',
      isAvailable: () => true,
      healthCheck: () => Promise.resolve(true),
      complete: async () => {
        inProvider += 1;
        peak = Math.max(peak, inProvider);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inProvider -= 1;
        return { text: '{"actions":[]}', latencyMs: 1, model: 'test-model' };
      },
      dispose: () => undefined,
    };
    const manager = new AIManager({
      config: { ...baseConfig, maxConcurrentRequests: Number.POSITIVE_INFINITY },
      providers: [provider],
    });

    await Promise.all([
      manager.plan({ instruction: 'a', requester: 'Alice', context }),
      manager.plan({ instruction: 'b', requester: 'Alice', context }),
    ]);

    // An infinite limit silently removed the bound; the fallback keeps the
    // requests serialised.
    expect(peak).toBe(1);

    await manager.dispose();
  });

  it('does not insta-reject a queued request when requestTimeoutMs is not finite', async () => {
    const manager = new AIManager({
      config: { ...baseConfig, requestTimeoutMs: Number.NaN },
      providers: [hangingProvider()],
    });

    const first = manager.plan({ instruction: 'a', requester: 'Alice', context });
    const second = manager.plan({ instruction: 'b', requester: 'Alice', context });
    await new Promise((resolve) => setTimeout(resolve, 60));

    // `setTimeout(fn, NaN)` fires after 1ms, which insta-rejected every queued
    // request with a nonsensical "after NaNms" message. The queue wait has to
    // use the documented floor instead.
    expect(manager.stats().queued).toBe(1);
    expect(manager.stats().rejected).toBe(0);

    await manager.dispose();
    await expect(first).rejects.toBeDefined();
    await expect(second).rejects.toBeDefined();
  });
});
