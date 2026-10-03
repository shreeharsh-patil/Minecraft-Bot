/**
 * Hard action ceilings and anti-grief predicates.
 *
 * These are the limits that hold even when the model is wrong or hostile:
 * rate budgets, world-border sanity checks, and "never quietly dismantle
 * someone's house" rules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ActionLimits,
  DEFAULT_MAX_BUILD,
  DEFAULT_MAX_MINE,
  DEFAULT_MAX_WAIT_MS,
  MAX_BUILD_DIMENSION,
  MAX_DROP_COUNT,
} from '../../src/safety/actionLimits.js';
import {
  AntiGriefRules,
  NATURAL_BLOCKS,
  PLAYER_STRUCTURE_BLOCKS,
  PROTECTED_BLOCKS,
} from '../../src/safety/antiGrief.js';
import type { SafetyConfig } from '../../src/config/config.js';
import type { BlockPos } from '../../src/types/world.js';

const AT: BlockPos = { x: 10, y: 64, z: -5 };

function safety(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    maxActionsPerMinute: 5,
    maxMiningBlocksPerTask: 32,
    maxBuildBlocksPerTask: 16,
    followDistance: 3,
    ...overrides,
  };
}

describe('ActionLimits - rate limiting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows actions up to the budget and then trips', () => {
    const limits = new ActionLimits(safety({ maxActionsPerMinute: 3 }));

    expect(limits.checkRate().allowed).toBe(true);
    expect(limits.checkRate().allowed).toBe(true);
    expect(limits.checkRate().allowed).toBe(true);

    const denied = limits.checkRate();
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('action rate limit reached (3/min)');
  });

  it('recovers once the window slides past a minute', () => {
    const limits = new ActionLimits(safety({ maxActionsPerMinute: 2 }));

    limits.checkRate();
    limits.checkRate();
    expect(limits.checkRate().allowed).toBe(false);

    vi.advanceTimersByTime(60_001);

    expect(limits.checkRate().allowed).toBe(true);
  });

  it('keeps denying inside the window', () => {
    const limits = new ActionLimits(safety({ maxActionsPerMinute: 1 }));

    expect(limits.checkRate().allowed).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(limits.checkRate().allowed).toBe(false);
  });

  it('treats 0 as "no limit"', () => {
    const limits = new ActionLimits(safety({ maxActionsPerMinute: 0 }));

    for (let i = 0; i < 50; i += 1) {
      expect(limits.checkRate().allowed).toBe(true);
    }
  });
});

describe('ActionLimits - per-task counters', () => {
  it('trips the mining counter at the ceiling and resets cleanly', () => {
    const limits = new ActionLimits(safety({ maxMiningBlocksPerTask: 4 }));

    expect(limits.recordMining(4).allowed).toBe(true);
    expect(limits.recordMining(1).allowed).toBe(false);
    expect(limits.snapshot().miningThisTask).toBe(5);

    limits.resetTaskCounters();
    expect(limits.snapshot().miningThisTask).toBe(0);
    expect(limits.recordMining(1).allowed).toBe(true);
  });

  it('trips the building counter at the ceiling', () => {
    const limits = new ActionLimits(safety({ maxBuildBlocksPerTask: 2 }));

    expect(limits.recordBuilding(2).allowed).toBe(true);
    expect(limits.recordBuilding(1).allowed).toBe(false);
    expect(limits.snapshot().buildingThisTask).toBe(3);
  });

  it('clamps requested counts into range', () => {
    const limits = new ActionLimits(safety({ maxMiningBlocksPerTask: 10, maxBuildBlocksPerTask: 4 }));

    expect(limits.clampMineCount(5)).toBe(5);
    expect(limits.clampMineCount(999)).toBe(10);
    expect(limits.clampMineCount(-3)).toBe(0);
    expect(limits.clampMineCount(Number.NaN)).toBe(0);
    expect(limits.clampMineCount(Number.POSITIVE_INFINITY)).toBe(0);

    expect(limits.clampBuildCount(999)).toBe(4);
    expect(limits.clampBuildCount(-1)).toBe(0);
  });

  it('reports a consistent snapshot', () => {
    const limits = new ActionLimits(safety());
    limits.recordMining(3);
    limits.recordBuilding(2);

    expect(limits.snapshot()).toEqual({
      miningThisTask: 3,
      buildingThisTask: 2,
      recentActions: 0,
    });
  });
});
describe('ActionLimits.checkAction - counts', () => {
  it('rejects a non-positive or non-numeric mining count', () => {
    const limits = new ActionLimits(safety());

    expect(limits.checkAction({ type: 'mine_block', count: 0 }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'mine_block', count: -5 }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'mine_block', count: 'lots' }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'mine_block' }).allowed).toBe(false);
  });

  it('rejects a mining count above the per-task limit', () => {
    const limits = new ActionLimits(safety({ maxMiningBlocksPerTask: 32 }));

    expect(limits.checkAction({ type: 'mine_block', count: 33 }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'mine_block', count: 32 }).allowed).toBe(true);
    expect(limits.checkAction({ type: 'collect_resource', count: 33 }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'collect_resource', count: 4 }).allowed).toBe(true);
  });

  it('rejects an invalid or oversized drop count', () => {
    const limits = new ActionLimits(safety());

    expect(limits.checkAction({ type: 'drop_item', count: -1 }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'drop_item', count: 'x' }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'drop_item', count: MAX_DROP_COUNT + 1 }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'drop_item', count: MAX_DROP_COUNT }).allowed).toBe(true);
    // A drop with no count is allowed and defaults at the cap.
    expect(limits.checkAction({ type: 'drop_item' }).allowed).toBe(true);
  });
});

describe('ActionLimits.checkAction - waits and durations', () => {
  it('rejects a negative or non-numeric wait', () => {
    const limits = new ActionLimits(safety());

    const negative = limits.checkAction({ type: 'wait', durationMs: -1 });
    expect(negative.allowed).toBe(false);
    expect(negative.reason).toBe('invalid wait duration');

    expect(limits.checkAction({ type: 'wait', durationMs: 'soon' }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'wait', durationMs: Number.NaN }).allowed).toBe(false);
  });

  it('rejects a wait longer than the cap', () => {
    const limits = new ActionLimits(safety());

    expect(limits.checkAction({ type: 'wait', durationMs: DEFAULT_MAX_WAIT_MS }).allowed).toBe(true);
    const tooLong = limits.checkAction({ type: 'wait', durationMs: DEFAULT_MAX_WAIT_MS + 1 });
    expect(tooLong.allowed).toBe(false);
    expect(tooLong.reason).toBe('wait too long');
  });

  it('accepts a zero wait and a valid defend duration', () => {
    const limits = new ActionLimits(safety());

    expect(limits.checkAction({ type: 'wait', durationMs: 0 }).allowed).toBe(true);
    expect(limits.checkAction({ type: 'defend_player', durationMs: 1_000 }).allowed).toBe(true);
    expect(limits.checkAction({ type: 'defend_player', durationMs: 0 }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'defend_player', durationMs: 600_001 }).allowed).toBe(false);
    // Omitted duration means "until stopped", which is allowed.
    expect(limits.checkAction({ type: 'defend_player' }).allowed).toBe(true);
  });
});
describe('ActionLimits.checkAction - positions', () => {
  it('rejects a missing or malformed position', () => {
    const limits = new ActionLimits(safety());

    expect(limits.checkAction({ type: 'move_to_position' }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'place_block', position: {} }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'place_block', position: { x: 1, y: 2 } }).allowed).toBe(false);
    expect(
      limits.checkAction({ type: 'place_block', position: { x: '1', y: 2, z: 3 } }).allowed,
    ).toBe(false);
  });

  it('rejects non-finite coordinates', () => {
    const limits = new ActionLimits(safety());

    const result = limits.checkAction({
      type: 'move_to_position',
      position: { x: Number.NaN, y: 64, z: 0 },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('position must be finite');
  });

  it('rejects positions outside the world border', () => {
    const limits = new ActionLimits(safety());

    for (const position of [
      { x: 30_000_001, y: 64, z: 0 },
      { x: 0, y: 64, z: -30_000_001 },
      { x: 0, y: 20_000_001, z: 0 },
      { x: Number.MAX_SAFE_INTEGER, y: 64, z: Number.MAX_SAFE_INTEGER },
    ]) {
      const result = limits.checkAction({ type: 'move_to_position', position });
      expect(result.allowed, JSON.stringify(position)).toBe(false);
      expect(result.reason).toBe('position is outside the world border');
    }
  });

  it('accepts an ordinary in-world position', () => {
    const limits = new ActionLimits(safety());

    expect(limits.checkAction({ type: 'move_to_position', position: AT }).allowed).toBe(true);
    expect(
      limits.checkAction({
        type: 'place_block',
        position: { x: -29_999_999, y: 319, z: 29_999_999 },
      }).allowed,
    ).toBe(true);
  });
});

describe('ActionLimits.checkAction - build dimensions', () => {
  it('requires dimensions', () => {
    const limits = new ActionLimits(safety());
    const result = limits.checkAction({ type: 'build_structure' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('build_structure requires dimensions');
  });

  it('rejects a single oversized dimension', () => {
    const limits = new ActionLimits(safety());

    const result = limits.checkAction({
      type: 'build_structure',
      dimensions: { length: MAX_BUILD_DIMENSION + 1 },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(`dimension exceeds ${MAX_BUILD_DIMENSION}`);
  });

  it('rejects a non-positive or non-numeric dimension', () => {
    const limits = new ActionLimits(safety());

    expect(limits.checkAction({ type: 'build_structure', dimensions: { length: 0 } }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'build_structure', dimensions: { length: -3 } }).allowed).toBe(false);
    expect(limits.checkAction({ type: 'build_structure', dimensions: { length: 'big' } }).allowed).toBe(false);
  });

  it('rejects a volume over the build limit even when each side fits', () => {
    const limits = new ActionLimits(safety({ maxBuildBlocksPerTask: 16 }));

    // 3*3*3 = 27 > 16, but every side is under MAX_BUILD_DIMENSION.
    const result = limits.checkAction({
      type: 'build_structure',
      dimensions: { length: 3, height: 3, depth: 3 },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeds limit 16');
  });

  it('accepts a structure within both the dimension and volume limits', () => {
    const limits = new ActionLimits(safety({ maxBuildBlocksPerTask: 16 }));

    expect(
      limits.checkAction({ type: 'build_structure', dimensions: { length: 2, height: 2, depth: 2 } })
        .allowed,
    ).toBe(true);
  });
});

describe('ActionLimits.checkAction - defaults', () => {
  it('allows actions it has no specific rule for', () => {
    const limits = new ActionLimits(safety());

    expect(limits.checkAction({ type: 'stop' }).allowed).toBe(true);
    expect(limits.checkAction({ type: 'look_at', position: AT }).allowed).toBe(true);
    expect(limits.checkAction({ type: 'equip_item' }).allowed).toBe(true);
  });

  it('exposes the documented default ceilings', () => {
    expect(DEFAULT_MAX_MINE).toBe(512);
    expect(DEFAULT_MAX_BUILD).toBe(256);
    expect(DEFAULT_MAX_WAIT_MS).toBe(30_000);
    expect(MAX_BUILD_DIMENSION).toBe(32);
    expect(MAX_DROP_COUNT).toBe(64);
  });
});
describe('AntiGriefRules - player structures', () => {
  const rules = new AntiGriefRules();

  it('refuses to break chests and other player structure blocks', () => {
    for (const block of ['chest', 'trapped_chest', 'ender_chest', 'barrel', 'crafting_table', 'furnace', 'anvil']) {
      const result = rules.canBreakBlock(block, AT);
      expect(result.allowed, block).toBe(false);
      expect(result.reason, block).toContain('player structure block');
    }
  });

  it('refuses a structure block even when explicitly requested', () => {
    // An explicit request can override a *protected* block, never a container.
    const result = rules.canBreakBlock('chest', AT, {}, true);
    expect(result.allowed).toBe(false);
  });

  it('refuses to break farmland and crops', () => {
    for (const block of ['farmland', 'wheat', 'carrots', 'beetroots', 'sugar_cane']) {
      expect(rules.canBreakBlock(block, AT).allowed, block).toBe(false);
    }
  });

  it('allows an explicitly requested protected block', () => {
    const result = rules.canBreakBlock('farmland', AT, {}, true);
    expect(result.allowed).toBe(true);
  });

  it('refuses a block the world tracker knows a player placed', () => {
    const context = { protectedBlocks: new Set(['10,64,-5']) };

    const refused = rules.canBreakBlock('stone', AT, context);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('refusing to break a block placed by a player');

    const allowed = rules.canBreakBlock('stone', AT, context, true);
    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toBe('player block broken because explicitly requested');
  });

  it('keys protected positions by floored coordinates', () => {
    const context = { protectedBlocks: new Set(['10,64,-5']) };
    // 10.9/64.2/-4.9 floors to 10/64/-5, the same block.
    expect(rules.canBreakBlock('stone', { x: 10.9, y: 64.2, z: -4.9 }, context).allowed).toBe(false);
    // A neighbouring block is unaffected.
    expect(rules.canBreakBlock('stone', { x: 11, y: 64, z: -5 }, context).allowed).toBe(true);
  });
});

describe('AntiGriefRules - natural terrain', () => {
  const rules = new AntiGriefRules();

  it('allows natural stone, dirt and ores', () => {
    for (const block of ['stone', 'cobblestone', 'deepslate', 'dirt', 'grass_block', 'sand', 'gravel']) {
      expect(rules.canBreakBlock(block, AT).allowed, block).toBe(true);
    }
  });

  it('allows every ore', () => {
    for (const block of ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore', 'emerald_ore']) {
      expect(rules.canBreakBlock(block, AT).allowed, block).toBe(true);
      expect(NATURAL_BLOCKS.has(block), block).toBe(true);
    }
  });

  it('allows logs and leaves', () => {
    expect(rules.canBreakBlock('oak_log', AT).allowed).toBe(true);
    expect(rules.canBreakBlock('birch_leaves', AT).allowed).toBe(true);
  });

  it('allows an unknown block through (permissive default)', () => {
    expect(rules.canBreakBlock('some_mod_block', AT).allowed).toBe(true);
  });
});

describe('AntiGriefRules - placement', () => {
  const rules = new AntiGriefRules();

  it('allows placing into air and replaceable blocks', () => {
    for (const existing of [null, 'air', 'cave_air', 'void_air', 'water', 'lava', 'grass']) {
      expect(rules.canPlaceBlock(AT, existing).allowed, String(existing)).toBe(true);
    }
  });

  it('rejects placing into an occupied position', () => {
    for (const existing of ['stone', 'chest', 'oak_planks']) {
      const result = rules.canPlaceBlock(AT, existing);
      expect(result.allowed, existing).toBe(false);
      expect(result.reason, existing).toContain(`occupied by "${existing}"`);
    }
  });
});

describe('AntiGriefRules - player proximity and containers', () => {
  const rules = new AntiGriefRules();

  it('yields only when a human is right on top of the bot', () => {
    expect(rules.shouldYieldToPlayer({ nearestPlayerDistance: 0.5 })).toBe(true);
    expect(rules.shouldYieldToPlayer({ nearestPlayerDistance: 1.4 })).toBe(true);
    expect(rules.shouldYieldToPlayer({ nearestPlayerDistance: 1.5 })).toBe(false);
    expect(rules.shouldYieldToPlayer({ nearestPlayerDistance: 6 })).toBe(false);
  });

  it('does not yield when no player distance is known', () => {
    expect(rules.shouldYieldToPlayer({})).toBe(false);
    expect(rules.shouldYieldToPlayer()).toBe(false);
  });

  it('recognises a player-owned chest but does not refuse it', () => {
    const context = { playerContainers: new Set(['10,64,-5']) };

    const result = rules.canOpenChest(AT, context);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('player-owned chest');

    // An untracked chest is simply allowed with no note.
    expect(rules.canOpenChest({ x: 1, y: 2, z: 3 }, context).reason).toBeUndefined();
  });
});

describe('AntiGriefRules - exported block sets', () => {
  it('keeps the three categories disjoint where it matters', () => {
    // A player-structure block must never be silently breakable as nature.
    for (const block of PLAYER_STRUCTURE_BLOCKS) {
      expect(NATURAL_BLOCKS.has(block), block).toBe(false);
    }
  });

  it('classifies the blocks the tests rely on', () => {
    expect(PLAYER_STRUCTURE_BLOCKS.has('chest')).toBe(true);
    expect(PLAYER_STRUCTURE_BLOCKS.has('crafting_table')).toBe(true);
    expect(PROTECTED_BLOCKS.has('farmland')).toBe(true);
    expect(PROTECTED_BLOCKS.has('oak_planks')).toBe(true);
    expect(NATURAL_BLOCKS.has('stone')).toBe(true);
  });
});