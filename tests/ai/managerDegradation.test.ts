/**
 * The AIManager facade during a provider outage.
 *
 * The documented contract is "an empty array when the model declined or when
 * every provider failed - the bot must keep running either way". Before the
 * fix the manager rejected the request, which both broke the bot and made
 * the outage invisible in the stats.
 */
import { describe, expect, it } from 'vitest';
import { AIManager } from '../../src/ai/AIManager.js';
import type { AiConfig } from '../../src/config/config.js';
import type { CompactContext } from '../../src/ai/contextBuilder.js';
import { ProviderError } from '../../src/types/provider.js';
import type { AiProvider, CompletionResult, ProviderName } from '../../src/types/provider.js';

const config: AiConfig = {
  providers: [{ name: 'groq', apiKey: 'test-key', model: 'test-model' }],
  localPlanner: false,
  requestTimeoutMs: 500,
  circuitFailureThreshold: 2,
  circuitCooldownMs: 1_000,
  maxConcurrentRequests: 1,
};

const context: CompactContext = {
  position: { x: 12, y: 64, z: -8 },
  dimension: 'overworld',
  timeOfDay: 'day',
  health: { current: 20, max: 20 },
  hunger: { current: 20, saturation: 5 },
  task: null,
  targetPlayer: null,
  nearbyPlayers: [{ name: 'Alice', distance: 4, authorized: true, health: 20 }],
  nearbyHostiles: [],
  nearbyBlocks: [{ name: 'oak_log', distance: 5 }],
  dangerousBlocksNearby: [],
  inventory: { held: null, usedSlots: 1, freeSlots: 33, items: [] },
  recentChat: [],
};

/** A provider whose API is down. */
function deadProvider(name: ProviderName = 'groq'): AiProvider {
  return {
    name,
    model: 'm',
    isAvailable: () => true,
    healthCheck: () => Promise.resolve(true),
    complete: () => Promise.reject(new ProviderError(name, 'network', `${name}: ECONNREFUSED`, { retryable: true })),
    dispose: () => undefined,
  };
}

/** A provider that never answers, so the request can be aborted. */
function hangingProvider(): AiProvider {
  return {
    name: 'groq',
    model: 'm',
    isAvailable: () => true,
    healthCheck: () => Promise.resolve(true),
    complete: (req) =>
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

describe('AIManager - provider outage', () => {
  it('degrades to an empty plan when every provider fails', async () => {
    const manager = new AIManager({ config, providers: [deadProvider()] });

    const result = await manager.planDetailed({
      instruction: 'mine 5 logs',
      requester: 'Alice',
      context,
    });

    expect(result.actions).toEqual([]);
    expect(result.dropped[0]?.reason).toBe('ai-unavailable');
    await manager.dispose();
  });

  it('plan() resolves with an empty array instead of rejecting', async () => {
    const manager = new AIManager({ config, providers: [deadProvider()] });

    await expect(
      manager.plan({ instruction: 'mine 5 logs', requester: 'Alice', context }),
    ).resolves.toEqual([]);
    await manager.dispose();
  });

  it('counts the degraded plan so the outage is visible in the stats', async () => {
    const manager = new AIManager({ config, providers: [deadProvider()] });

    await manager.plan({ instruction: 'mine 5 logs', requester: 'Alice', context });

    const stats = manager.stats();
    expect(stats.planned).toBe(1);
    // The provider stats still show what actually went wrong.
    expect(stats.providers[0]?.failures).toBeGreaterThan(0);
    await manager.dispose();
  });

  it('still propagates a user abort instead of swallowing it into an empty plan', async () => {
    const manager = new AIManager({ config, providers: [hangingProvider()] });
    const controller = new AbortController();

    const promise = manager.plan({ instruction: 'mine 5 logs', requester: 'Alice', context, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
    await manager.dispose();
  });
});
