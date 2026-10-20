/**
 * Regression tests for the AIManager lifecycle.
 *
 * The bot issues `stopEverything()` before EVERY new request, which called
 * `cancelAll()`. That aborted a one-shot AbortController, so every later
 * request threw "AI manager is shutting down" - the AI path (and the offline
 * planner) never worked in the real bot, while the unit tests passed because
 * they never called cancelAll().
 */
import { describe, expect, it } from 'vitest';
import { AIManager } from '../../src/ai/AIManager.js';
import type { AiConfig } from '../../src/config/config.js';
import type { CompactContext } from '../../src/ai/contextBuilder.js';

const config: AiConfig = {
  providers: [],
  localPlanner: true,
  requestTimeoutMs: 2_000,
  circuitFailureThreshold: 2,
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

describe('AIManager - cancellation lifecycle', () => {
  it('still plans after cancelAll() (the "!stop"/new-request path)', async () => {
    const ai = new AIManager({ config });

    const first = await ai.planDetailed({ instruction: 'follow me', requester: 'Alice', context });
    expect(first.actions.length).toBeGreaterThan(0);

    // Exactly what the bot does before every new request.
    ai.cancelAll('new request');

    const second = await ai.planDetailed({ instruction: 'follow me', requester: 'Alice', context });
    expect(second.actions.length).toBeGreaterThan(0);
    expect(second.actions[0]).toMatchObject({ type: 'follow_player' });

    await ai.dispose();
  });

  it('keeps planning across repeated cancellations', async () => {
    const ai = new AIManager({ config });
    for (let round = 0; round < 3; round++) {
      ai.cancelAll('new request');
      const result = await ai.planDetailed({ instruction: 'come here', requester: 'Alice', context });
      expect(result.actions.length).toBeGreaterThan(0);
    }
    await ai.dispose();
  });

  it('does not leak a concurrency slot when a request is aborted', async () => {
    const ai = new AIManager({ config });
    const controller = new AbortController();
    controller.abort();

    await expect(
      ai.planDetailed({ instruction: 'follow me', requester: 'Alice', context, signal: controller.signal }),
    ).rejects.toThrow();

    expect(ai.stats().inFlight).toBe(0);

    // The manager must still be usable afterwards.
    const result = await ai.planDetailed({ instruction: 'follow me', requester: 'Alice', context });
    expect(result.actions.length).toBeGreaterThan(0);
    expect(ai.stats().inFlight).toBe(0);

    await ai.dispose();
  });

  it('reports how many requests were cancelled', async () => {
    const ai = new AIManager({ config });
    expect(ai.cancelAll('test')).toBe(0);
    await ai.dispose();
  });

  it('refuses to plan after dispose', async () => {
    const ai = new AIManager({ config });
    await ai.dispose();
    await expect(
      ai.planDetailed({ instruction: 'follow me', requester: 'Alice', context }),
    ).rejects.toThrow(/disposed/);
  });
});
