/**
 * Task lifecycle and arbitration.
 *
 * Invariants:
 *  - exactly one task per conflict group may be active;
 *  - `cancel()` aborts the task's AbortSignal synchronously, so `!stop`
 *    takes effect immediately even mid-pathfinding or mid-AI-call;
 *  - no timers or listeners outlive a task.
 */
import { randomUUID } from 'node:crypto';
import type {
  CreateTaskInput,
  TaskRecord,
  TaskConflictGroup,
  ProgressReporter,
  TaskProgress,
} from '../types/task.js';
import { isTerminalStatus } from '../types/task.js';
import type { Logger } from '../utils/logger.js';

export interface TaskExecutionContext {
  readonly task: TaskRecord;
  readonly signal: AbortSignal;
  readonly progress: ProgressReporter;
  readonly say: (message: string) => void;
}

export interface TaskHandle {
  readonly record: TaskRecord;
  readonly signal: AbortSignal;
  /** Runs the body with a fully-formed ExecutionContext. */
  run<T>(body: (ctx: TaskExecutionContext) => Promise<T>): Promise<T>;
  cancel(reason?: string): void;
}

interface TaskEntry extends TaskHandle {
  record: TaskRecord;
  controller: AbortController;
  /** Cleanup functions run exactly once when the task settles. */
  cleanups: Array<() => void>;
  settled: boolean;
}

export class TaskManager {
  private readonly logger: Logger;
  private readonly tasks = new Map<string, TaskEntry>();
  /** conflictGroup -> active task id. */
  private readonly byGroup = new Map<string, string>();
  /** Called when any task reaches a terminal state. */
  private onSettle?: (record: TaskRecord) => void;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'task-manager' });
  }

  setSettleListener(listener: (record: TaskRecord) => void): void {
    this.onSettle = listener;
  }

  /**
   * Claims the body for a conflict group.
   *
   * An existing task in the same group is cancelled as the new one takes the
   * group over (the newest instruction wins), which matches how players
   * actually talk to the bot: "stop, actually come here" should not need two
   * commands.
   */
  start(input: CreateTaskInput): TaskHandle {
    const group: TaskConflictGroup = input.conflictGroup;
    const previousId = this.byGroup.get(group);

    const id = randomUUID();
    const controller = new AbortController();

    const record: TaskRecord = {
      id,
      owner: input.owner,
      type: input.type,
      status: 'queued',
      priority: input.priority ?? 0,
      createdAt: Date.now(),
      conflictGroup: group,
      progress: { fraction: null, current: 0, total: null },
      steps: input.steps ?? [],
      currentStep: 0,
      cancel: () => {
        this.cancel(id, 'cancelled via handle');
      },
    };

    const entry: TaskEntry = {
      record,
      controller,
      cleanups: [],
      settled: false,
      signal: controller.signal,
      run: async (body) => {
        if (entry.settled) throw new Error('cannot run a task that has already finished');
        record.status = 'running';
        record.startedAt = Date.now();
        const ctx: TaskExecutionContext = {
          task: record,
          signal: controller.signal,
          progress: (patch) => {
            record.progress = { ...record.progress, ...patch } satisfies TaskProgress;
          },
          say: (message: string) => {
            this.logger.info('task message', { task: id, owner: input.owner, message });
          },
        };
        return body(ctx);
      },
      cancel: (reason?: string) => {
        this.cancel(id, reason ?? 'cancelled via handle');
      },
    };

    this.tasks.set(id, entry);
    // The group is claimed BEFORE the previous holder is cancelled. Cancelling
    // runs the cleanups and the settle listener, and either of them may start
    // a task of its own; claiming the group afterwards would silently drop
    // that task's claim and leave two live tasks in the same body group.
    if (group !== 'none') this.byGroup.set(group, id);
    if (previousId !== undefined) {
      this.logger.debug('cancelling conflicting task', { group, previous: previousId });
      this.cancel(previousId, `superseded by ${input.owner}`);
    }

    this.logger.debug('task created', {
      id,
      type: record.type,
      owner: record.owner,
      group,
      priority: record.priority,
    });

    return entry;
  }

  /** Registers a cleanup callback to run when the task settles. */
  onCleanup(taskId: string, fn: () => void): void {
    const entry = this.tasks.get(taskId);
    if (entry && !entry.settled) entry.cleanups.push(fn);
    else fn();
  }

  /**
   * Aborts a task. Safe to call from any state, including before `run`.
   * Settlement happens immediately so `!stop` never waits on anything.
   */
  cancel(taskId: string, reason = 'cancelled'): void {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.settled) return;

    entry.settled = true;
    // The record is updated before the abort: abort listeners run
    // synchronously, and the skill being stopped must see the task as
    // cancelled rather than as still running.
    entry.record.status = 'cancelled';
    entry.record.finishedAt = Date.now();
    entry.record.error = reason;
    // Aborting first is what makes cancellation instant for skills and AI calls.
    if (!entry.controller.signal.aborted) entry.controller.abort(new Error(reason));

    this.release(entry);
    this.logger.info('task cancelled', { id: taskId, reason, type: entry.record.type });
    this.onSettle?.(entry.record);
  }

  /** Marks a task as finished with a terminal status. */
  complete(
    taskId: string,
    status: 'completed' | 'failed' | 'cancelled',
    error?: string,
  ): void {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    entry.record.status = status;
    entry.record.finishedAt = Date.now();
    if (error) entry.record.error = error;
    if (status === 'cancelled') {
      // A task reported as cancelled has to stop: the abort is what reaches
      // the skill and the AI call, exactly as `cancel()` does.
      const reason = entry.record.error ?? 'cancelled';
      entry.record.error = reason;
      if (!entry.controller.signal.aborted) entry.controller.abort(new Error(reason));
    }
    this.release(entry);
    this.logger.info('task finished', { id: taskId, status, type: entry.record.type });
    this.onSettle?.(entry.record);
  }

  pause(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.settled || entry.record.status !== 'running') return;
    entry.record.status = 'paused';
    this.logger.info('task paused', { id: taskId });
  }

  resume(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.settled || entry.record.status !== 'paused') return;
    entry.record.status = 'running';
    this.logger.info('task resumed', { id: taskId });
  }

  setPlanning(taskId: string): void {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.settled) return;
    entry.record.status = 'planning';
  }

  /** Cancels the task holding a given group, if any. */
  cancelGroup(group: string, reason = 'cancelled'): boolean {
    const id = this.byGroup.get(group);
    if (id === undefined) return false;
    this.cancel(id, reason);
    return true;
  }

  /** Cancels everything. Used by `!stop` and shutdown. */
  cancelAll(reason = 'cancelled'): number {
    let count = 0;
    for (const [id, entry] of [...this.tasks]) {
      if (!entry.settled) {
        this.cancel(id, reason);
        count += 1;
      }
    }
    return count;
  }

  /** Current task for a group, if any. */
  activeTask(group: string): TaskRecord | undefined {
    const id = this.byGroup.get(group);
    if (id === undefined) return undefined;
    const entry = this.tasks.get(id);
    return entry && !entry.settled ? entry.record : undefined;
  }

  list(includeFinished = false): TaskRecord[] {
    const all = [...this.tasks.values()].map((e) => e.record);
    return includeFinished ? all : all.filter((r) => !isTerminalStatus(r.status));
  }

  /** Drops settled tasks from memory. Returns how many were pruned. */
  prune(): number {
    let removed = 0;
    for (const [id, entry] of this.tasks) {
      if (entry.settled) {
        this.tasks.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Settles a task after its body resolves/rejects.
   * Wraps the run body so callers cannot forget to close a task out.
   */
  async execute<T>(
    handle: TaskHandle,
    body: (ctx: TaskExecutionContext) => Promise<T>,
  ): Promise<T | null> {
    if (handle.signal.aborted) return null;
    try {
      const result = await handle.run(body);
      this.complete(handle.record.id, 'completed');
      return result;
    } catch (error) {
      if (handle.signal.aborted) {
        this.cancel(handle.record.id, 'aborted during execution');
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.complete(handle.record.id, 'failed', message);
      throw error;
    }
  }

  private release(entry: TaskEntry): void {
    const group = entry.record.conflictGroup;
    if (this.byGroup.get(group) === entry.record.id) {
      this.byGroup.delete(group);
    }
    for (const fn of entry.cleanups) {
      try {
        fn();
      } catch (error) {
        // A failing cleanup must never block the others.
        this.logger.warn('task cleanup failed', {
          task: entry.record.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    entry.cleanups.length = 0;
  }
}
