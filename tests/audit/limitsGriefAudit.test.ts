/**
 * Audit of the two safety ceilings: the action limits and the anti-grief
 * rules.
 *
 * Every test here is a regression test for a defect that was proven against
 * the code: a limit that could be switched off by a broken count, a rate
 * window that could never slide again, a player build the bot was allowed to
 * dismantle, and a placement that quietly destroyed a player's torch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionLimits } from '../../src/safety/actionLimits.js';
import { AntiGriefRules } from '../../src/safety/antiGrief.js';
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

describe('ActionLimits - the rate window survives a clock that jumps', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a fresh window when the wall clock jumps backwards', () => {
    const limits = new ActionLimits(safety({ maxActionsPerMinute: 2 }));

    expect(limits.checkRate().allowed).toBe(true);
    expect(limits.checkRate().allowed).toBe(true);
    expect(limits.checkRate().allowed).toBe(false);

    // The wall clock is moved back (NTP, a manual change, a suspended
    // machine). The timestamps already in the window are now "in the
    // future", so `now - t` stays negative and they can never slide out:
    // without the reset the bot is locked out of every action until the
    // clock catches up.
    vi.setSystemTime(Date.now() - 120_000);

    expect(limits.checkRate().allowed).toBe(true);
  });

  it('still denies inside the window when the clock did not move', () => {
    const limits = new ActionLimits(safety({ maxActionsPerMinute: 2 }));

    limits.checkRate();
    limits.checkRate();
    vi.advanceTimersByTime(30_000);

    expect(limits.checkRate().allowed).toBe(false);
  });
});

describe('ActionLimits - a broken count can never switch a ceiling off', () => {
  it('refuses to book a NaN mining count and keeps the counter clean', () => {
    const limits = new ActionLimits(safety({ maxMiningBlocksPerTask: 4 }));

    // A NaN in the counter is poison: `remainingMining()` returns NaN and
    // every comparison against NaN is false, so the executor's budget check
    // would let every later mining action through.
    expect(limits.recordMining(Number.NaN).allowed).toBe(false);
    expect(limits.snapshot().miningThisTask).toBe(0);
    expect(limits.remainingMining()).toBe(4);

    // The ceiling still applies exactly as before.
    expect(limits.recordMining(4).allowed).toBe(true);
    expect(limits.recordMining(1).allowed).toBe(false);
    expect(limits.remainingMining()).toBe(0);
  });

  it('refuses to book an infinite mining count', () => {
    const limits = new ActionLimits(safety({ maxMiningBlocksPerTask: 4 }));

    expect(limits.recordMining(Number.POSITIVE_INFINITY).allowed).toBe(false);
    expect(limits.snapshot().miningThisTask).toBe(0);
    expect(limits.remainingMining()).toBe(4);
  });

  it('refuses to book a negative count instead of handing out extra budget', () => {
    const limits = new ActionLimits(safety({ maxBuildBlocksPerTask: 2 }));

    // A negative count used to make the budget grow.
    expect(limits.recordBuilding(-5).allowed).toBe(false);
    expect(limits.snapshot().buildingThisTask).toBe(0);
    expect(limits.remainingBuilding()).toBe(2);

    expect(limits.recordBuilding(2).allowed).toBe(true);
    expect(limits.recordBuilding(1).allowed).toBe(false);
  });

  it('books a plain count exactly as before', () => {
    const limits = new ActionLimits(safety({ maxMiningBlocksPerTask: 10 }));

    expect(limits.recordMining(3).allowed).toBe(true);
    expect(limits.recordMining().allowed).toBe(true);
    expect(limits.snapshot().miningThisTask).toBe(4);
    expect(limits.remainingMining()).toBe(6);
  });
});

describe('AntiGriefRules - player builds of every wood, bed and wall', () => {
  const rules = new AntiGriefRules();

  it('protects the planks of every wood, not just the first six', () => {
    for (const block of [
      'mangrove_planks',
      'cherry_planks',
      'pale_oak_planks',
      'bamboo_planks',
      'crimson_planks',
      'warped_planks',
    ]) {
      expect(rules.canBreakBlock(block, AT).allowed, block).toBe(false);
    }
  });

  it('protects every bed colour', () => {
    for (const colour of [
      'white',
      'orange',
      'magenta',
      'light_blue',
      'yellow',
      'lime',
      'pink',
      'gray',
      'light_gray',
      'cyan',
      'purple',
      'blue',
      'brown',
      'green',
      'red',
      'black',
    ]) {
      expect(rules.canBreakBlock(`${colour}_bed`, AT).allowed, colour).toBe(false);
    }
  });

  it('protects every wall, sign and banner', () => {
    for (const block of [
      'mossy_cobblestone_wall',
      'stone_brick_wall',
      'nether_brick_wall',
      'deepslate_brick_wall',
      'polished_blackstone_brick_wall',
      'spruce_wall_sign',
      'birch_sign',
      'cherry_sign',
      'white_banner',
      'lime_banner',
      'red_shulker_box',
    ]) {
      expect(rules.canBreakBlock(block, AT).allowed, block).toBe(false);
    }
  });

  it('protects the blocks a build is usually made of', () => {
    for (const block of [
      'bookshelf',
      'chiseled_bookshelf',
      'scaffolding',
      'iron_bars',
      'crafter',
      'fletching_table',
      'decorated_pot',
      'dispenser',
      'dropper',
    ]) {
      expect(rules.canBreakBlock(block, AT).allowed, block).toBe(false);
    }
  });

  it('still mines natural terrain', () => {
    for (const block of ['stone', 'cobblestone', 'deepslate', 'dirt', 'oak_log']) {
      expect(rules.canBreakBlock(block, AT).allowed, block).toBe(true);
    }
  });
});

describe('AntiGriefRules - the structure around a player container', () => {
  const rules = new AntiGriefRules();
  const context = { playerContainers: new Set(['11,64,-5']) };

  it('refuses to break a block inside the structure of a player container', () => {
    const result = rules.canBreakBlock('smooth_stone', { x: 11, y: 64, z: -5 }, context);

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/structure/i);
  });

  it('leaves blocks that are far away from the container alone', () => {
    expect(rules.canBreakBlock('smooth_stone', { x: 40, y: 64, z: -5 }, context).allowed).toBe(true);
  });

  it('still digs stone next to a player container', () => {
    // Natural terrain is never part of a player's build.
    expect(rules.canBreakBlock('stone', { x: 11, y: 64, z: -5 }, context).allowed).toBe(true);
    expect(rules.canBreakBlock('cobblestone', { x: 12, y: 64, z: -5 }, context).allowed).toBe(true);
  });

  it('gives way to an explicit request', () => {
    const allowed = rules.canBreakBlock('smooth_stone', { x: 11, y: 64, z: -5 }, context, true);
    expect(allowed.allowed).toBe(true);
  });

  it('never breaks the container itself, not even on request', () => {
    const refused = rules.canBreakBlock('chest', { x: 11, y: 64, z: -5 }, context, true);
    expect(refused.allowed).toBe(false);
  });
});

describe('AntiGriefRules - a torch is not a replaceable target', () => {
  const rules = new AntiGriefRules();

  it('refuses to build over a torch', () => {
    // A torch is a player structure, not vegetation: building into it would
    // silently destroy the player's light.
    const result = rules.canPlaceBlock(AT, 'torch');

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('torch');
  });

  it('still builds into air, vegetation and fluids', () => {
    for (const existing of [null, 'air', 'cave_air', 'water', 'lava', 'grass', 'short_grass', 'snow']) {
      expect(rules.canPlaceBlock(AT, existing).allowed, String(existing)).toBe(true);
    }
  });
});
