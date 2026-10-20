/**
 * The executor is the single funnel: whatever produced an action - the model,
 * the deterministic command parser or a direct caller - it is validated here
 * before a skill can touch the world.
 *
 * These tests pin the funnel's guarantees:
 *  - an action the validator rejects never reaches a skill;
 *  - the anti-grief rules are enforced before a block is broken;
 *  - the per-task ceilings are booked and enforced across a plan;
 *  - a `stop` inside a plan really stops the body.
 */
import { describe, expect, it } from 'vitest';
import { ActionExecutor } from '../../src/executor/actionExecutor.js';
import { TaskManager } from '../../src/executor/actionQueue.js';
import { ActionLimits } from '../../src/safety/actionLimits.js';
import { AntiGriefRules } from '../../src/safety/antiGrief.js';
import { createSkillRegistry } from '../../src/skills/index.js';
import { validateAction } from '../../src/executor/validator.js';
import { silentLogger } from '../../src/utils/logger.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import type { SafetyConfig } from '../../src/config/config.js';
import type { BotAction } from '../../src/types/actions.js';

function safety(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    maxActionsPerMinute: 120,
    maxMiningBlocksPerTask: 32,
    maxBuildBlocksPerTask: 16,
    followDistance: 3,
    ...overrides,
  };
}

interface Harness {
  executor: ActionExecutor;
  limits: ActionLimits;
  facade: FakeMinecraftFacade;
  tasks: TaskManager;
}

function harness(facade: FakeMinecraftFacade, limits = new ActionLimits(safety())): Harness {
  const tasks = new TaskManager(silentLogger);
  const executor = new ActionExecutor({
    facade,
    tasks,
    limits,
    antiGrief: new AntiGriefRules(),
    logger: silentLogger,
    registry: createSkillRegistry(facade),
    say: () => undefined,
  });
  return { executor, limits, facade, tasks };
}

describe('ActionExecutor - the validation funnel', () => {
  it('refuses an action the validator rejects', async () => {
    const facade = new FakeMinecraftFacade({ blocks: [{ name: 'stone', at: { x: 2, y: 64, z: 0 } }] });
    const { executor } = harness(facade);

    // A block name that is not a block name at all: path traversal, injection.
    const result = await executor.runSingle('Alice', {
      type: 'mine_block',
      blockName: '../../etc/passwd',
      count: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/blockName/i);
    // Nothing was dug.
    expect(facade.dugPositions).toHaveLength(0);
    expect(facade.calls).not.toContain('digBlock');
  });

  it('refuses an action type that is not on the allowlist', async () => {
    const facade = new FakeMinecraftFacade();
    const { executor } = harness(facade);

    const result = await executor.runSingle('Alice', {
      type: 'run_command',
      command: 'op Alice',
    } as unknown as BotAction);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/allowlist/i);
  });

  it('runs the validated action, so a human-written name still works', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { iron_pickaxe: 1 } });
    const { executor } = harness(facade);

    const result = await executor.runSingle('Alice', {
      type: 'equip_item',
      item: 'Iron Pickaxe',
    });

    expect(result.ok).toBe(true);
    expect(facade.equippedItems).toContain('iron_pickaxe');
  });

  it('refuses to mine a chest, so a player never loses their chest', async () => {
    const facade = new FakeMinecraftFacade({
      blocks: [{ name: 'chest', at: { x: 2, y: 64, z: 0 } }],
    });
    const { executor } = harness(facade);

    const result = await executor.runSingle('Alice', { type: 'mine_block', blockName: 'chest', count: 1 });

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/player structure block/i);
    expect(facade.dugPositions).toHaveLength(0);
    expect(facade.getBlockAt({ x: 2, y: 64, z: 0 })).toBe('chest');
  });
});

describe('ActionExecutor - per-task ceilings', () => {
  it('books the blocks a plan mines and refuses to go over the ceiling', async () => {
    const facade = new FakeMinecraftFacade({
      inventory: { iron_axe: 1 },
      blocks: Array.from({ length: 40 }, (_unused, i) => ({
        name: 'oak_log',
        at: { x: 2 + i, y: 64, z: 0 },
      })),
      tools: { oak_log: 'iron_axe' },
    });
    const limits = new ActionLimits(safety({ maxMiningBlocksPerTask: 32 }));
    const { executor } = harness(facade, limits);

    const outcome = await executor.runPlan('Alice', [
      { type: 'mine_block', blockName: 'oak_log', count: 20 },
      { type: 'mine_block', blockName: 'oak_log', count: 20 },
    ]);

    // The first step fits in the budget, the second does not.
    expect(outcome.completed).toEqual(['mine_block']);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.reason).toMatch(/may be mined in this task/i);
    expect(limits.snapshot().miningThisTask).toBe(20);
  });

  it('resets the per-task counters at the start of every plan', async () => {
    const facade = new FakeMinecraftFacade({
      inventory: { iron_axe: 1 },
      blocks: Array.from({ length: 10 }, (_unused, i) => ({
        name: 'oak_log',
        at: { x: 2 + i, y: 64, z: 0 },
      })),
      tools: { oak_log: 'iron_axe' },
    });
    const limits = new ActionLimits(safety({ maxMiningBlocksPerTask: 32 }));
    const { executor } = harness(facade, limits);

    await executor.runPlan('Alice', [{ type: 'mine_block', blockName: 'oak_log', count: 5 }]);
    expect(limits.snapshot().miningThisTask).toBe(5);

    await executor.runPlan('Alice', [{ type: 'mine_block', blockName: 'oak_log', count: 5 }]);
    // The second plan starts from zero, so five more blocks are allowed.
    expect(limits.snapshot().miningThisTask).toBe(5);
  });

  it('counts the blocks a build places', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 16 } });
    const limits = new ActionLimits(safety({ maxBuildBlocksPerTask: 16 }));
    const { executor } = harness(facade, limits);

    await executor.runPlan('Alice', [
      {
        type: 'build_structure',
        structure: 'platform',
        position: { x: 0, y: 64, z: 0 },
        dimensions: { length: 4, width: 4 },
      },
    ]);

    expect(limits.snapshot().buildingThisTask).toBe(16);
  });
});

describe('ActionExecutor - a stop inside a plan', () => {
  it('really stops the body', async () => {
    const facade = new FakeMinecraftFacade({
      players: [{ name: 'Alice', distance: 5, position: { x: 5, y: 64, z: 0 }, authorized: true }],
    });
    const { executor } = harness(facade);

    const outcome = await executor.runPlan('Alice', [
      { type: 'move_to_player', player: 'Alice' },
      { type: 'stop' },
      { type: 'move_to_player', player: 'Alice' },
    ]);

    expect(outcome.cancelled).toBe(true);
    expect(outcome.completed).toContain('stop');
    // The stop skill ran, so the body was halted.
    expect(facade.stopMovingCount).toBeGreaterThan(0);
    expect(facade.getGoal()).toBeNull();
    // The plan really stopped: the action after the stop never ran.
    expect(facade.moveToPlayerCalls).toHaveLength(1);
  });
});

describe('ActionExecutor - validation predicts execution', () => {
  it('refuses a wait the executor would refuse', async () => {
    const facade = new FakeMinecraftFacade();
    const { executor, limits } = harness(facade);

    const action: BotAction = { type: 'wait', durationMs: 60_000 };
    expect(validateAction(action).valid).toBe(false);
    expect(limits.checkAction({ type: 'wait', durationMs: 60_000 }).allowed).toBe(false);

    const result = await executor.runSingle('Alice', action);
    expect(result.ok).toBe(false);
  });

  it('refuses a drop count the executor would refuse', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { dirt: 200 } });
    const { executor, limits } = harness(facade);

    const action: BotAction = { type: 'drop_item', item: 'dirt', count: 100 };
    expect(validateAction(action).valid).toBe(false);
    expect(limits.checkAction({ type: 'drop_item', count: 100 }).allowed).toBe(false);

    const result = await executor.runSingle('Alice', action);
    expect(result.ok).toBe(false);
    expect(facade.dropped).toHaveLength(0);
  });

  it('still runs an ordinary action', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { dirt: 5 } });
    const { executor } = harness(facade);

    const result = await executor.runSingle('Alice', { type: 'drop_item', item: 'dirt', count: 2 });

    expect(result.ok).toBe(true);
    expect(facade.dropped).toEqual([{ item: 'dirt', count: 2 }]);
  });
});
