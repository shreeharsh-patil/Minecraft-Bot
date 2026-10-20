/** Task model. One task owns the bot's body at a time; conflicts are explicit. */
import type { ActionType } from './actions.js';

export const TASK_STATUSES = [
  'queued',
  'planning',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Conflict groups. Only one task per group may hold the bot at a time.
 *
 * The groups describe the KIND of work, not the body: `mine_block` is filed
 * under `mining` and `move_to_player` under `movement`, so a mining task and
 * a movement task are allowed to be live at the same time - and both of them
 * walk the bot around. The scheduler in `src/executor/actionQueue.ts`
 * arbitrates on the group name alone.
 *
 * Frozen: the vocabulary is closed, so a group name cannot be changed at
 * runtime out from under the scheduler that arbitrates on it.
 */
export const CONFLICT_GROUP = Object.freeze({
  MOVEMENT: 'movement',
  MINING: 'mining',
  BUILDING: 'building',
  INVENTORY: 'inventory',
  COMBAT: 'combat',
  NONE: 'none',
} as const);

export type ConflictGroup = (typeof CONFLICT_GROUP)[keyof typeof CONFLICT_GROUP];

/** Every conflict group the bot knows, as a runtime list. */
export const CONFLICT_GROUPS: readonly ConflictGroup[] = Object.freeze(
  Object.values(CONFLICT_GROUP),
);

/**
 * Is this one of the known conflict groups?
 *
 * The scheduler arbitrates on the exact group name, so a typo ("move"
 * instead of "movement") does not merely look wrong: it creates a SECOND
 * group that never arbitrates against the real one, and two tasks that both
 * need the body end up running at the same time. Check any group name that
 * comes from outside this module.
 */
export function isConflictGroup(value: unknown): value is ConflictGroup {
  return typeof value === 'string' && (CONFLICT_GROUPS as readonly string[]).includes(value);
}

/**
 * Groups a task/skill may occupy.
 *
 * This is an open string union so a skill can declare its own group without
 * importing the concrete enum values. The vocabulary the scheduler knows is
 * `CONFLICT_GROUP` above - use `isConflictGroup` to check a name that comes
 * from outside this module, because a name outside it is a typo and a typo
 * is a second, silent conflict group.
 */
export type TaskConflictGroup = ConflictGroup | (string & {});

export interface TaskProgress {
  /** 0..1, or null when the task cannot meaningfully report progress. */
  fraction: number | null;
  current: number;
  total: number | null;
  detail?: string;
}

export interface TaskRecord {
  id: string;
  owner: string;
  type: ActionType | 'composite' | 'deterministic';
  status: TaskStatus;
  priority: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  conflictGroup: TaskConflictGroup;
  progress: TaskProgress;
  /** Human-readable steps for status reporting. */
  steps: string[];
  currentStep: number;
  error?: string;
  cancel: () => void;
}

export interface CreateTaskInput {
  owner: string;
  type: TaskRecord['type'];
  conflictGroup: TaskConflictGroup;
  priority?: number;
  steps?: string[];
}

export type ProgressReporter = (progress: Partial<TaskProgress>) => void;

export interface ExecutionContext {
  readonly task: TaskRecord;
  readonly signal: AbortSignal;
  /** Report progress; the fraction is derived and clamped to 0..1. */
  readonly progress: ProgressReporter;
  /** Say something back to the owner in chat (already rate-limited + redacted). */
  readonly say: (message: string) => void;
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}