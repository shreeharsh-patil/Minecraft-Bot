/**
 * End-to-end insurance: with zero API keys and the default config, the bot
 * still plans. AIManager selects the algorithmic LocalPlanner and every action
 * it emits is a validated allowlist shape.
 */
import { describe, expect, it } from 'vitest';
import { AIManager } from '../../src/ai/AIManager.js';
import type { AiConfig } from '../../src/config/config.js';
import { parseActions } from '../../src/ai/planner.js';
import { buildCompactContext, type CompactContext } from '../../src/ai/contextBuilder.js';

const config: AiConfig = {
  providers: [],
  localPlanner: true,
  requestTimeoutMs: 2_000,
  circuitFailureThreshold: 2,
  circuitCooldownMs: 1_000,
  maxConcurrentRequests: 1,
};

const context: CompactContext = {
  position: { x: 12, y: 64, z: -8 },
  dimension: 'overworld',
  timeOfDay: 'night',
  health: { current: 20, max: 20 },
  hunger: { current: 20, saturation: 5 },
  task: null,
  targetPlayer: null,
  nearbyPlayers: [{ name: 'Alice', distance: 4, authorized: true, health: 20 }],
  nearbyHostiles: [{ name: 'zombie', distance: 3, health: 12 }],
  nearbyBlocks: [{ name: 'iron_ore', distance: 6 }],
  dangerousBlocksNearby: [],
  inventory: { held: null, usedSlots: 1, freeSlots: 34, items: [{ name: 'iron_sword', count: 1 }] },
  recentChat: [],
};

/** Cross-check: local output satisfies the same validator used by LLM plans. */
function expectAllowlisted(actions: ReturnType<typeof parseActions>['actions']): void {
  const parsed = parseActions({ actions });
  expect(parsed.dropped).toEqual([]);
  expect(parsed.actions.length).toBeGreaterThan(0);
}

describe('AIManager zero-key fallback', () => {
  it('plans with no providers using the local mode', async () => {
    const ai = new AIManager({ config });
    expect(ai.plannerMode).toBe('local');

    const result = await ai.planDetailed({
      instruction: 'follow me',
      requester: 'Alice',
      context,
    });
    // Self-preservation first (a zombie is 3 blocks away in the snapshot),
    // then the requested follow. Both must be allowlist-valid.
    expect(result.actions[0]).toMatchObject({ type: 'attack_hostile', target: 'zombie' });
    expect(result.actions[result.actions.length - 1]).toMatchObject({
      type: 'follow_player',
      player: 'Alice',
    });
    expectAllowlisted(result.actions);
    await ai.dispose();
  });

  it('still answers questions with a bounded chat line', async () => {
    const ai = new AIManager({ config });
    const result = await ai.planDetailed({
      instruction: 'what time is it?',
      requester: 'Alice',
      context,
    });
    const say = result.actions[0];
    expect(say?.type).toBe('say');
    expectAllowlisted(result.actions);
    await ai.dispose();
  });

  it('works through buildCompactContext-shaped input too', async () => {
    const ai = new AIManager({ config });
    const compact = buildCompactContext(
      {
        getPosition: () => context.position,
        getDimension: () => context.dimension,
        getTimeOfDay: () => 'night',
        getHealth: () => context.health,
        getHunger: () => context.hunger,
        getNearbyPlayers: () => [{ name: 'Alice', distance: 4, authorized: true, position: context.position }],
        getNearbyEntities: () => [],
        scanNearbyBlocks: () => [],
        getInventory: () => [],
        heldItem: () => null,
      },
      { targetPlayer: 'Alice', conversation: [], objective: null },
    );
    const result = await ai.planDetailed({
      instruction: 'mine 5 cobblestone',
      requester: 'Alice',
      context: compact,
    });
    expect(result.actions[0]).toMatchObject({ type: 'mine_block', blockName: 'cobblestone' });
    expectAllowlisted(result.actions);
    await ai.dispose();
  });
});
