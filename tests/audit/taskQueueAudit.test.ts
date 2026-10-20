/**
 * Audit of the task manager (src/executor/actionQueue.ts).
 *
 * Three defects are pinned here:
 *  - completing a task as 'cancelled' never aborted its AbortSignal, so the
 *    abort never reached the skill that was supposed to stop;
 *  - a new task claimed its conflict group only AFTER the previous holder
 *    had been cancelled, so a task started from a cleanup (or from the settle
 *    listener) lost its claim and two live tasks ended up sharing a body
 *    group - the invariant the file documents at the top;
 *  - cancelling updated the record only AFTER aborting, so the abort
 *    listener - the skill being stopped - saw the task as still running.
 */
import { describe, expect, it } from 'vitest';
import { TaskManager } from '../../src/executor/actionQueue.js';
import type { TaskHandle } from '../../src/executor/actionQueue.js';
import type { CreateTaskInput, TaskRecord } from '../../src/types/task.js';
import { silentLogger } from '../../src/utils/logger.js';

function input(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    owner: 'Alice',
    type: 'move_to_position',
    conflictGroup: 'movement',
    ...overrides,
  };
}

/** The tasks of a group that are still live (list() hides terminal ones). */
function liveIn(tasks: TaskManager, group: string): TaskRecord[] {
  return tasks.list().filter((r) => r.conflictGroup === group);
}

describe('audit: completing a task as cancelled aborts the skill', () => {
  it('aborts the signal when a task is completed as cancelled', () => {
    const tasks = new TaskManager(silentLogger);
    const handle = tasks.start(input());

    tasks.complete(handle.record.id, 'cancelled', 'stopped by alice');

    expect(handle.signal.aborted).toBe(true);
    expect(handle.record.status).toBe('cancelled');
    expect(handle.record.error).toBe('stopped by alice');
  });

  it('delivers the abort to the skill that is running', async () => {
    const tasks = new TaskManager(silentLogger);
    const handle = tasks.start(input());
    let abortedInside = false;

    const running = handle.run(async (ctx) => {
      ctx.signal.addEventListener('abort', () => {
        abortedInside = true;
      });
      await Promise.resolve();
    });

    tasks.complete(handle.record.id, 'cancelled');

    await running;
    expect(abortedInside).toBe(true);
    expect(handle.signal.aborted).toBe(true);
  });

  it('reports a task completed as cancelled as cancelled, not as a failure', async () => {
    const tasks = new TaskManager(silentLogger);
    const handle = tasks.start(input());

    const pending = tasks.execute(
      handle,
      (ctx) =>
        new Promise<never>((_resolve, reject) => {
          // The fallback keeps the test from hanging when the abort is missing.
          const timer = setTimeout(() => reject(new Error('body timed out')), 50);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
    );

    tasks.complete(handle.record.id, 'cancelled');

    await expect(pending).resolves.toBeNull();
    expect(handle.record.status).toBe('cancelled');
  });

  it('leaves the signal alone for the other terminal statuses', () => {
    const tasks = new TaskManager(silentLogger);

    const done = tasks.start(input({ conflictGroup: 'mining' }));
    tasks.complete(done.record.id, 'completed');
    expect(done.signal.aborted).toBe(false);

    const failed = tasks.start(input({ conflictGroup: 'building' }));
    tasks.complete(failed.record.id, 'failed', 'boom');
    expect(failed.signal.aborted).toBe(false);
  });
});

describe('audit: a conflict group keeps exactly one live task', () => {
  it('keeps the claim of a task started from a cleanup of the task it replaced', () => {
    const tasks = new TaskManager(silentLogger);
    const first = tasks.start(input({ conflictGroup: 'movement' }));
    let followUp: TaskHandle | undefined;
    tasks.onCleanup(first.record.id, () => {
      followUp = tasks.start(input({ conflictGroup: 'movement', owner: 'Cleanup' }));
    });

    tasks.start(input({ conflictGroup: 'movement' }));

    expect(followUp).toBeDefined();
    const live = liveIn(tasks, 'movement');
    expect(live).toHaveLength(1);
    // The live task is the one the group points at, so `cancelGroup` and
    // `activeTask` act on it.
    expect(tasks.activeTask('movement')?.id).toBe(live[0]?.id);
  });

  it('keeps the claim of a task started from the settle listener', () => {
    const tasks = new TaskManager(silentLogger);
    let started = false;
    tasks.setSettleListener(() => {
      if (started) return;
      started = true;
      tasks.start(input({ conflictGroup: 'movement', owner: 'Listener' }));
    });

    tasks.start(input({ conflictGroup: 'movement' }));
    tasks.start(input({ conflictGroup: 'movement' }));

    const live = liveIn(tasks, 'movement');
    expect(live).toHaveLength(1);
    expect(tasks.activeTask('movement')?.id).toBe(live[0]?.id);
  });

  it('lets cancelGroup reach the live task of the group', () => {
    const tasks = new TaskManager(silentLogger);
    const first = tasks.start(input({ conflictGroup: 'movement' }));
    tasks.onCleanup(first.record.id, () => {
      tasks.start(input({ conflictGroup: 'movement', owner: 'Cleanup' }));
    });

    tasks.start(input({ conflictGroup: 'movement' }));

    const live = liveIn(tasks, 'movement');
    expect(live).toHaveLength(1);
    expect(tasks.cancelGroup('movement')).toBe(true);
    expect(live[0]?.status).toBe('cancelled');
  });

  it('still cancels the previous holder of a group (newest wins)', () => {
    const tasks = new TaskManager(silentLogger);
    const first = tasks.start(input({ conflictGroup: 'movement' }));
    const second = tasks.start(input({ conflictGroup: 'movement' }));

    expect(first.signal.aborted).toBe(true);
    expect(first.record.status).toBe('cancelled');
    expect(second.signal.aborted).toBe(false);
    expect(tasks.activeTask('movement')?.id).toBe(second.record.id);
  });
});

describe('audit: the record is consistent while the abort is delivered', () => {
  it('reports the task as cancelled to the abort listener', async () => {
    const tasks = new TaskManager(silentLogger);
    const handle = tasks.start(input());
    let seen: { status: string; error: string | undefined; finishedAt: number | undefined } | undefined;

    const running = handle.run(async (ctx) => {
      ctx.signal.addEventListener('abort', () => {
        seen = {
          status: ctx.task.status,
          error: ctx.task.error,
          finishedAt: ctx.task.finishedAt,
        };
      });
      await Promise.resolve();
    });

    tasks.cancel(handle.record.id, 'stop');

    await running;
    expect(seen?.status).toBe('cancelled');
    expect(seen?.error).toBe('stop');
    expect(seen?.finishedAt).toBeGreaterThan(0);
  });
});
