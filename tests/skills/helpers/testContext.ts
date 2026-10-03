/** Minimal `ExecutionContext` for skill tests, with recording. */
import type { ExecutionContext, TaskProgress, TaskRecord } from '../../../src/types/task.js';

export interface TestContext {
  ctx: ExecutionContext;
  /** Fires the abort signal - the `!stop` path. */
  abort: () => void;
  readonly progressUpdates: Array<Partial<TaskProgress>>;
  readonly messages: string[];
  readonly cancelled: boolean;
}

export function createTestContext(): TestContext {
  const controller = new AbortController();
  const progressUpdates: Array<Partial<TaskProgress>> = [];
  const messages: string[] = [];

  const task: TaskRecord = {
    id: 'test-task',
    owner: 'Tester',
    type: 'wait',
    status: 'running',
    priority: 0,
    createdAt: Date.now(),
    conflictGroup: 'none',
    progress: { fraction: 0, current: 0, total: null },
    steps: [],
    currentStep: 0,
    cancel: () => controller.abort(),
  };

  const ctx: ExecutionContext = {
    task,
    signal: controller.signal,
    progress: (update) => {
      progressUpdates.push(update);
    },
    say: (message) => {
      messages.push(message);
    },
  };

  return {
    ctx,
    abort: () => controller.abort(),
    progressUpdates,
    messages,
    get cancelled(): boolean {
      return controller.signal.aborted;
    },
  };
}