/**
 * Task lifecycle, arbitration and cancellation.
 *
 * The invariant that matters most: `cancel()` must abort the AbortSignal
 * synchronously, so `!stop` takes effect immediately even while a skill is
 * mid-pathfinding or an AI call is in flight. These tests pin that, plus
 * cleanup-exactly-once and conflict-group arbitration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskManager } from '../../src/executor/actionQueue.js';
import type { TaskHandle } from '../../src/executor/actionQueue.js';
import type { CreateTaskInput } from '../../src/types/task.js';
import { silentLogger } from '../../src/utils/logger.js';

function input(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    owner: 'Alice',
    type: 'move_to_position',
    conflictGroup: 'movement',
    ...overrides,
  };
}

describe('TaskManager - cancellation aborts synchronously', () => {
  let tasks: TaskManager;

  beforeEach(() => {
    tasks = new TaskManager(silentLogger);
  });

  it('aborts the signal the moment cancel() returns', () => {
    const handle = tasks.start(input());
    expect(handle.signal.aborted).toBe(false);

    tasks.cancel(handle.record.id, 'user pressed stop');

    // No await, no microtask: already aborted on the next line.
    expect(handle.signal.aborted).toBe(true);
  });

  it('records the cancellation reason on the record', () => {
    const handle = tasks.start(input());

    tasks.cancel(handle.record.id, 'because I said so');

    expect(handle.record.status).toBe('cancelled');
    expect(handle.record.error).toBe('because I said so');
    expect(handle.record.finishedAt).toBeGreaterThan(0);
  });

  it('aborts a task that is currently running its body', async () => {
    const handle = tasks.start(input());
    let abortedInside = false;

    const running = handle.run(async (ctx) => {
      expect(ctx.signal.aborted).toBe(false);
      ctx.signal.addEventListener('abort', () => {
        abortedInside = true;
      });
      await Promise.resolve();
    });

    tasks.cancel(handle.record.id, 'stop');

    await running;
    expect(abortedInside).toBe(true);
    expect(handle.signal.aborted).toBe(true);
  });

  it('aborts through the handle and through record.cancel()', () => {
    const viaHandle = tasks.start(input());
    viaHandle.cancel('via handle');
    expect(viaHandle.signal.aborted).toBe(true);

    const viaRecord = tasks.start(input({ conflictGroup: 'mining' }));
    viaRecord.record.cancel();
    expect(viaRecord.signal.aborted).toBe(true);
  });

  it('cancels a task that has not started running yet', () => {
    const handle = tasks.start(input());
    tasks.cancel(handle.record.id);

    expect(handle.signal.aborted).toBe(true);
    expect(handle.record.status).toBe('cancelled');
  });

  it('is idempotent and safe for an unknown id', () => {
    const handle = tasks.start(input());

    expect(() => tasks.cancel(handle.record.id)).not.toThrow();
    expect(() => tasks.cancel(handle.record.id)).not.toThrow();
    expect(() => tasks.cancel('not-a-real-task')).not.toThrow();

    // The first reason wins.
    expect(handle.record.error).toBe('cancelled');
  });

  it('cancels a task by conflict group', () => {
    const handle = tasks.start(input({ conflictGroup: 'mining' }));

    expect(tasks.cancelGroup('mining')).toBe(true);
    expect(handle.signal.aborted).toBe(true);
    expect(tasks.cancelGroup('mining')).toBe(false);
    expect(tasks.cancelGroup('never-used')).toBe(false);
  });
});

describe('TaskManager - cancelAll', () => {
  let tasks: TaskManager;

  beforeEach(() => {
    tasks = new TaskManager(silentLogger);
  });

  it('cancels every active task and reports the count', () => {
    const a = tasks.start(input({ conflictGroup: 'movement' }));
    const b = tasks.start(input({ conflictGroup: 'mining' }));
    const c = tasks.start(input({ conflictGroup: 'building' }));

    const count = tasks.cancelAll('shutdown');

    expect(count).toBe(3);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(c.signal.aborted).toBe(true);
  });

  it('does not count already-settled tasks', () => {
    const settled = tasks.start(input({ conflictGroup: 'mining' }));
    tasks.complete(settled.record.id, 'completed');
    const active = tasks.start(input({ conflictGroup: 'movement' }));

    expect(tasks.cancelAll()).toBe(1);
    expect(active.signal.aborted).toBe(true);
  });

  it('returns 0 when there is nothing to cancel', () => {
    expect(tasks.cancelAll()).toBe(0);
  });

  it('leaves the manager empty afterwards', () => {
    tasks.start(input({ conflictGroup: 'movement' }));
    tasks.start(input({ conflictGroup: 'mining' }));
    tasks.cancelAll();

    expect(tasks.list()).toHaveLength(0);
    expect(tasks.activeTask('movement')).toBeUndefined();
  });
});
describe('TaskManager - conflict groups', () => {
  let tasks: TaskManager;

  beforeEach(() => {
    tasks = new TaskManager(silentLogger);
  });

  it('cancels the previous task when a group is re-claimed', () => {
    const first = tasks.start(input({ conflictGroup: 'movement' }));
    const second = tasks.start(input({ conflictGroup: 'movement' }));

    expect(first.signal.aborted).toBe(true);
    expect(first.record.status).toBe('cancelled');
    expect(first.record.error).toContain('superseded by Alice');
    expect(second.signal.aborted).toBe(false);
  });

  it('keeps exactly one active task per group', () => {
    const first = tasks.start(input({ conflictGroup: 'movement' }));
    const second = tasks.start(input({ conflictGroup: 'movement' }));
    const third = tasks.start(input({ conflictGroup: 'movement' }));

    expect(tasks.activeTask('movement')?.id).toBe(third.record.id);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(third.signal.aborted).toBe(false);
  });

  it('lets different groups run concurrently', () => {
    const move = tasks.start(input({ conflictGroup: 'movement' }));
    const mine = tasks.start(input({ conflictGroup: 'mining' }));

    expect(move.signal.aborted).toBe(false);
    expect(mine.signal.aborted).toBe(false);
  });

  it('does not arbitrate the "none" group', () => {
    const a = tasks.start(input({ conflictGroup: 'none' }));
    const b = tasks.start(input({ conflictGroup: 'none' }));

    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);
    expect(tasks.activeTask('none')).toBeUndefined();
  });

  it('frees the group once the task settles', () => {
    const first = tasks.start(input({ conflictGroup: 'movement' }));
    tasks.complete(first.record.id, 'completed');

    const second = tasks.start(input({ conflictGroup: 'movement' }));
    expect(second.signal.aborted).toBe(false);
    expect(first.record.error).toBeUndefined();
  });
});

describe('TaskManager - cleanup callbacks', () => {
  let tasks: TaskManager;

  beforeEach(() => {
    tasks = new TaskManager(silentLogger);
  });

  it('runs every cleanup exactly once on cancel', () => {
    const handle = tasks.start(input());
    const first = vi.fn();
    const second = vi.fn();

    tasks.onCleanup(handle.record.id, first);
    tasks.onCleanup(handle.record.id, second);
    expect(first).not.toHaveBeenCalled();

    tasks.cancel(handle.record.id);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    // A second cancel must not re-run them.
    tasks.cancel(handle.record.id);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('runs cleanups exactly once on completion', () => {
    const handle = tasks.start(input());
    const cleanup = vi.fn();
    tasks.onCleanup(handle.record.id, cleanup);

    tasks.complete(handle.record.id, 'completed');

    expect(cleanup).toHaveBeenCalledTimes(1);
    tasks.complete(handle.record.id, 'failed');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not let a throwing cleanup escape cancel()', () => {
    const handle = tasks.start(input());
    const before = vi.fn();
    const boom = vi.fn(() => {
      throw new Error('cleanup exploded');
    });
    const after = vi.fn();

    tasks.onCleanup(handle.record.id, before);
    tasks.onCleanup(handle.record.id, boom);
    tasks.onCleanup(handle.record.id, after);

    expect(() => tasks.cancel(handle.record.id)).not.toThrow();

    // A failing cleanup must not block the others.
    expect(before).toHaveBeenCalledTimes(1);
    expect(boom).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(handle.record.status).toBe('cancelled');
  });

  it('runs an immediately-registered cleanup for an unknown task', () => {
    const cleanup = vi.fn();
    tasks.onCleanup('no-such-task', cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs a cleanup immediately when the task has already settled', () => {
    const handle = tasks.start(input());
    tasks.cancel(handle.record.id);

    const late = vi.fn();
    tasks.onCleanup(handle.record.id, late);

    expect(late).toHaveBeenCalledTimes(1);
  });
});
describe('TaskManager - prune and listing', () => {
  let tasks: TaskManager;

  beforeEach(() => {
    tasks = new TaskManager(silentLogger);
  });

  it('removes settled tasks and keeps active ones', () => {
    const done = tasks.start(input({ conflictGroup: 'mining' }));
    const cancelled = tasks.start(input({ conflictGroup: 'building' }));
    const active = tasks.start(input({ conflictGroup: 'movement' }));

    tasks.complete(done.record.id, 'completed');
    tasks.cancel(cancelled.record.id);

    expect(tasks.prune()).toBe(2);
    expect(tasks.prune()).toBe(0);

    const remaining = tasks.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(active.record.id);
  });

  it('excludes settled tasks from list() by default', () => {
    const done = tasks.start(input());
    const active = tasks.start(input({ conflictGroup: 'mining' }));
    tasks.complete(done.record.id, 'completed');

    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list().map((t) => t.id)).toEqual([active.record.id]);
  });

  it('includes settled tasks when asked', () => {
    const done = tasks.start(input());
    const active = tasks.start(input({ conflictGroup: 'mining' }));
    tasks.complete(done.record.id, 'completed');

    const all = tasks.list(true);
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.id).sort()).toEqual([done.record.id, active.record.id].sort());
  });

  it('reports no active task for a settled group', () => {
    const handle = tasks.start(input({ conflictGroup: 'movement' }));
    expect(tasks.activeTask('movement')?.id).toBe(handle.record.id);

    tasks.cancel(handle.record.id);
    expect(tasks.activeTask('movement')).toBeUndefined();
  });
});

describe('TaskManager - execute', () => {
  let tasks: TaskManager;

  beforeEach(() => {
    tasks = new TaskManager(silentLogger);
  });

  it('returns the body result and marks the task completed', async () => {
    const handle = tasks.start(input());
    expect(handle.record.status).toBe('queued');

    const result = await tasks.execute(handle, (ctx) => {
      expect(ctx.task.id).toBe(handle.record.id);
      expect(ctx.task.status).toBe('running');
      return Promise.resolve('arrived');
    });

    expect(result).toBe('arrived');
    expect(handle.record.status).toBe('completed');
    expect(handle.record.error).toBeUndefined();
    expect(handle.record.finishedAt).toBeGreaterThan(0);
  });

  it('marks the task failed and rethrows on a body error', async () => {
    const handle = tasks.start(input());

    await expect(
      tasks.execute(handle, () => Promise.reject(new Error('pathfinding failed'))),
    ).rejects.toThrow('pathfinding failed');

    expect(handle.record.status).toBe('failed');
    expect(handle.record.error).toBe('pathfinding failed');
  });

  it('records a non-Error rejection as a string', async () => {
    const handle = tasks.start(input());
    // Deliberately not an Error: execute() coerces the reason with String().
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercising the non-Error branch
    const notAnError = (): Promise<never> => Promise.reject('plain string');

    await expect(tasks.execute(handle, notAnError)).rejects.toBe('plain string');
    expect(handle.record.error).toBe('plain string');
  });

  it('returns null without running the body when already cancelled', async () => {
    const handle = tasks.start(input());
    tasks.cancel(handle.record.id, 'stopped first');

    const body = vi.fn(() => Promise.resolve('never'));
    const result = await tasks.execute(handle, body);

    expect(result).toBeNull();
    expect(body).not.toHaveBeenCalled();
    expect(handle.record.status).toBe('cancelled');
  });

  it('returns null and cancels when aborted mid-flight', async () => {
    const handle = tasks.start(input());

    const pending = tasks.execute(
      handle,
      (ctx) =>
        new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    tasks.cancel(handle.record.id, 'stopped mid-flight');

    await expect(pending).resolves.toBeNull();
    expect(handle.record.status).toBe('cancelled');
  });

  it('runs cleanups registered inside the body when execute settles', async () => {
    const handle = tasks.start(input());
    const cleanup = vi.fn();

    await tasks.execute(handle, () => {
      tasks.onCleanup(handle.record.id, cleanup);
      return Promise.resolve('ok');
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('refuses to run a task that has already settled', async () => {
    const handle = tasks.start(input());
    tasks.cancel(handle.record.id);

    await expect(handle.run(() => Promise.resolve(1))).rejects.toThrow('already finished');
  });

  it('notifies the settle listener exactly once per task', async () => {
    const settled = vi.fn();
    tasks.setSettleListener(settled);

    const handle = tasks.start(input());
    await tasks.execute(handle, () => Promise.resolve('done'));
    expect(settled).toHaveBeenCalledTimes(1);

    tasks.complete(handle.record.id, 'completed');
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('reports progress and messages through the execution context', async () => {
    const handle = tasks.start(input({ steps: ['walk', 'arrive'] }));

    await tasks.execute(handle, (ctx) => {
      ctx.progress({ current: 1, total: 2, fraction: 0.5 });
      ctx.say('on my way');
      return Promise.resolve();
    });

    expect(handle.record.progress).toMatchObject({ current: 1, total: 2, fraction: 0.5 });
  });
});
describe('TaskManager - pause and resume', () => {
  let tasks: TaskManager;

  beforeEach(() => {
    tasks = new TaskManager(silentLogger);
  });

  it('moves a running task through paused and back', async () => {
    const handle = tasks.start(input());
    const running = handle.run(async () => {
      await Promise.resolve();
    });

    tasks.pause(handle.record.id);
    expect(handle.record.status).toBe('paused');

    tasks.resume(handle.record.id);
    expect(handle.record.status).toBe('running');

    await running;
  });

  it('ignores pause/resume for a settled task', () => {
    const handle = tasks.start(input());
    tasks.cancel(handle.record.id);

    tasks.pause(handle.record.id);
    tasks.resume(handle.record.id);

    expect(handle.record.status).toBe('cancelled');
  });

  it('cannot resume a task that was never paused', () => {
    const handle = tasks.start(input());
    tasks.resume(handle.record.id);
    expect(handle.record.status).toBe('queued');
  });
});

describe('TaskManager - handle shape', () => {
  it('starts a queued task with the supplied metadata', () => {
    const tasks = new TaskManager(silentLogger);
    const handle: TaskHandle = tasks.start(
      input({
        owner: 'Bob',
        type: 'composite',
        conflictGroup: 'building',
        priority: 5,
        steps: ['a'],
      }),
    );

    expect(handle.record.owner).toBe('Bob');
    expect(handle.record.type).toBe('composite');
    expect(handle.record.priority).toBe(5);
    expect(handle.record.conflictGroup).toBe('building');
    expect(handle.record.steps).toEqual(['a']);
    expect(handle.record.status).toBe('queued');
    expect(handle.record.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives every task a unique id', () => {
    const tasks = new TaskManager(silentLogger);
    const ids = new Set(
      Array.from({ length: 20 }, () => tasks.start(input({ conflictGroup: 'none' })).record.id),
    );
    expect(ids.size).toBe(20);
  });

  it('supports the setPlanning transition', () => {
    const tasks = new TaskManager(silentLogger);
    const handle = tasks.start(input({ type: 'composite' }));

    tasks.setPlanning(handle.record.id);
    expect(handle.record.status).toBe('planning');
  });
});