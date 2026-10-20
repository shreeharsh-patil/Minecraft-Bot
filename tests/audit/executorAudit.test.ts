/**
 * Audit of the executor - the single funnel where a validated action becomes a
 * world change.
 *
 * The executor's own documentation makes four promises that are easy to break
 * from the inside, because the skill layer reports cancellation in its RESULT
 * instead of throwing:
 *
 *  - "stop the whole sequence the moment the plan is cancelled";
 *  - "Always halt the body when a task is cancelled";
 *  - "one plan may not mine or place more blocks than the budget allows";
 *  - an action whose signal is already aborted must never reach the world.
 *
 * These tests use injected fake skills (the executor takes the registry as a
 * dependency) so they can reproduce a cancellation exactly the way the real
 * skills behave: the skill returns `{ok: false}` and never throws.
 */
import { describe, expect, it } from 'vitest';
import { ActionExecutor } from '../../src/executor/actionExecutor.js';
import { TaskManager } from '../../src/executor/actionQueue.js';
import { ActionLimits } from '../../src/safety/actionLimits.js';
import { AntiGriefRules } from '../../src/safety/antiGrief.js';
import { silentLogger } from '../../src/utils/logger.js';
import { createDeferred } from '../../src/utils/sleep.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import type { ActionType, BotAction } from '../../src/types/actions.js';
import type { ExecutionContext } from '../../src/types/task.js';
import type { Skill, SkillResult } from '../../src/types/skill.js';
import type { SafetyConfig } from '../../src/config/config.js';

type SkillImpl = (params: BotAction, ctx: ExecutionContext) => Promise<SkillResult>;

/** A skill that behaves like the real ones: it reports, it never throws. */
function fakeSkill(name: ActionType, impl: SkillImpl): Skill<never> {
  const skill: Skill<BotAction> = {
    name,
    conflictGroups: [],
    execute: impl,
  };
  return skill;
}

/** Resolves once the signal fires - how the real skills notice a cancel. */
function untilAborted(ctx: ExecutionContext): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ctx.signal.aborted) {
      resolve();
      return;
    }
    ctx.signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function safety(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    maxActionsPerMinute: 120,
    maxMiningBlocksPerTask: 8,
    maxBuildBlocksPerTask: 8,
    followDistance: 3,
    ...overrides,
  };
}

interface Harness {
  executor: ActionExecutor;
  limits: ActionLimits;
  facade: FakeMinecraftFacade;
}

function harness(
  registry: Map<ActionType, Skill<never>>,
  limits = new ActionLimits(safety()),
): Harness {
  const facade = new FakeMinecraftFacade();
  const tasks = new TaskManager(silentLogger);
  const executor = new ActionExecutor({
    facade,
    tasks,
    limits,
    antiGrief: new AntiGriefRules(),
    logger: silentLogger,
    registry,
    say: () => undefined,
  });
  return { executor, limits, facade };
}

describe('ActionExecutor - a cancelled action stops its plan', () => {
  it('does not carry on with the next step after an action was cancelled', async () => {
    const walking = createDeferred<void>();
    const ran: string[] = [];

    const registry = new Map<ActionType, Skill<never>>([
      [
        'move_to_player',
        fakeSkill('move_to_player', async (_params, ctx) => {
          walking.resolve();
          await untilAborted(ctx);
          // Exactly what the real movement skill does: it reports the
          // cancellation and returns, it does not throw.
          return { ok: false, detail: 'Stopped while walking to Alice.' };
        }),
      ],
      [
        'mine_block',
        fakeSkill('mine_block', () => {
          ran.push('mine_block');
          return Promise.resolve({ ok: true, count: 1 });
        }),
      ],
      [
        'move_to_position',
        fakeSkill('move_to_position', () => Promise.resolve({ ok: true, count: 0 })),
      ],
    ]);
    const { executor } = harness(registry);

    const plan = executor.runPlan('Alice', [
      { type: 'move_to_player', player: 'Alice' },
      { type: 'mine_block', blockName: 'oak_log', count: 1 },
    ]);
    await walking.promise;

    // A newer instruction claims the body: the movement conflict group takes
    // the plan's walking task away from it.
    await executor.runSingle('Bob', { type: 'move_to_position', position: { x: 4, y: 64, z: 0 } });

    const outcome = await plan;

    // The cancelled step ends the plan - the mining step never runs.
    expect(ran).toEqual([]);
    expect(outcome.cancelled).toBe(true);
    expect(outcome.completed).toEqual([]);
  });

  it('halts the body when an action is cancelled', async () => {
    const walking = createDeferred<void>();

    const registry = new Map<ActionType, Skill<never>>([
      [
        'move_to_player',
        fakeSkill('move_to_player', async (_params, ctx) => {
          walking.resolve();
          await untilAborted(ctx);
          return { ok: false, detail: 'Stopped while walking to Alice.' };
        }),
      ],
      [
        'move_to_position',
        fakeSkill('move_to_position', () => Promise.resolve({ ok: true, count: 0 })),
      ],
    ]);
    const { executor, facade } = harness(registry);

    const plan = executor.runPlan('Alice', [{ type: 'move_to_player', player: 'Alice' }]);
    await walking.promise;
    await executor.runSingle('Bob', { type: 'move_to_position', position: { x: 4, y: 64, z: 0 } });
    await plan;

    // The body must not keep walking after a cancelled action.
    expect(facade.stopMovingCount).toBeGreaterThan(0);
  });

  it('reports a cancelled plan as cancelled, not as a failed step', async () => {
    const waiting = createDeferred<void>();

    const registry = new Map<ActionType, Skill<never>>([
      [
        'wait',
        fakeSkill('wait', async (_params, ctx) => {
          waiting.resolve();
          await untilAborted(ctx);
          return { ok: false, detail: 'Stopped waiting.' };
        }),
      ],
    ]);
    const { executor } = harness(registry);

    const plan = executor.runPlan('Alice', [{ type: 'wait', durationMs: 5_000 }]);
    await waiting.promise;
    expect(executor.cancelActivePlan('stop')).toBe(true);

    const outcome = await plan;

    // The plan was stopped, so it is cancelled - not a failed wait.
    expect(outcome.cancelled).toBe(true);
    expect(outcome.failed).toEqual([]);
    expect(outcome.completed).toEqual([]);
  });

  it('still books the blocks a cancelled mining action broke', async () => {
    const mining = createDeferred<void>();

    const registry = new Map<ActionType, Skill<never>>([
      [
        'mine_block',
        fakeSkill('mine_block', async (_params, ctx) => {
          mining.resolve();
          await untilAborted(ctx);
          // Three blocks were broken before the cancel arrived.
          return { ok: false, detail: 'Stopped mining oak logs after 3.', count: 3 };
        }),
      ],
    ]);
    const limits = new ActionLimits(safety({ maxMiningBlocksPerTask: 8 }));
    const { executor } = harness(registry, limits);

    const plan = executor.runPlan('Alice', [{ type: 'mine_block', blockName: 'oak_log', count: 8 }]);
    await mining.promise;
    executor.cancelActivePlan('stop');
    await plan;

    // The blocks really were broken, so they count against the ceiling.
    expect(limits.snapshot().miningThisTask).toBe(3);
  });
});

describe('ActionExecutor - the per-task budget belongs to the running task', () => {
  it('does not let a standalone action wipe the budget of a running plan', async () => {
    const waiting = createDeferred<void>();
    const release = createDeferred<void>();

    const registry = new Map<ActionType, Skill<never>>([
      [
        'mine_block',
        fakeSkill('mine_block', (params) =>
          Promise.resolve({
            ok: true,
            count: (params as { count: number }).count,
          }),
        ),
      ],
      [
        'wait',
        fakeSkill('wait', async () => {
          waiting.resolve();
          await release.promise;
          return { ok: true, count: 0 };
        }),
      ],
      ['drop_item', fakeSkill('drop_item', () => Promise.resolve({ ok: true, count: 0 }))],
    ]);
    const limits = new ActionLimits(safety({ maxMiningBlocksPerTask: 8 }));
    const { executor } = harness(registry, limits);

    const plan = executor.runPlan('Alice', [
      { type: 'mine_block', blockName: 'oak_log', count: 8 },
      { type: 'wait', durationMs: 1 },
      { type: 'mine_block', blockName: 'oak_log', count: 8 },
    ]);
    await waiting.promise;
    expect(limits.snapshot().miningThisTask).toBe(8);

    // A deterministic command lands while the plan is still running.
    await executor.runSingle('Bob', { type: 'drop_item', item: 'dirt' });

    release.resolve();
    const outcome = await plan;

    // The ceiling is eight blocks for this task: the second mining step is
    // still refused, no matter what else ran in the meantime.
    expect(outcome.completed).toEqual(['mine_block', 'wait']);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.reason).toMatch(/mining limit reached|may be mined in this task/i);
    expect(limits.snapshot().miningThisTask).toBe(8);
  });

  it('still starts a standalone action on a fresh budget when nothing else runs', async () => {
    const registry = new Map<ActionType, Skill<never>>([
      [
        'mine_block',
        fakeSkill('mine_block', (params) =>
          Promise.resolve({
            ok: true,
            count: (params as { count: number }).count,
          }),
        ),
      ],
    ]);
    const limits = new ActionLimits(safety({ maxMiningBlocksPerTask: 8 }));
    const { executor } = harness(registry, limits);

    await executor.runSingle('Alice', { type: 'mine_block', blockName: 'oak_log', count: 8 });
    expect(limits.snapshot().miningThisTask).toBe(8);

    // A second standalone action is a task of its own: it starts fresh.
    const result = await executor.runSingle('Alice', {
      type: 'mine_block',
      blockName: 'oak_log',
      count: 8,
    });
    expect(result.ok).toBe(true);
    expect(limits.snapshot().miningThisTask).toBe(8);
  });
});

describe('ActionExecutor - an aborted signal stops the action', () => {
  it('never runs an action whose signal is already aborted', async () => {
    let ran = 0;
    const registry = new Map<ActionType, Skill<never>>([
      [
        'drop_item',
        fakeSkill('drop_item', () => {
          ran += 1;
          return Promise.resolve({ ok: true, count: 1 });
        }),
      ],
    ]);
    const { executor } = harness(registry);

    const controller = new AbortController();
    controller.abort();

    const result = await executor.runSingle(
      'Alice',
      { type: 'drop_item', item: 'dirt' },
      controller.signal,
    );

    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(ran).toBe(0);
  });
});
