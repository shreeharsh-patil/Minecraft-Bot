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

export const CONFLICT_GROUP = {
  MOVEMENT: 'movement',
  MINING: 'mining',
  BUILDING: 'building',
  INVENTORY: 'inventory',
  COMBAT: 'combat',
  NONE: 'none',
} as const;

export type ConflictGroup = (typeof CONFLICT_GROUP)[keyof typeof CONFLICT_GROUP];

/**
 * Groups a task/skill may occupy. This is an open string union so a skill can
 * declare its own group without importing the concrete enum values.
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
  /** Report progress; also enforces `max` where applicable. */
  readonly progress: ProgressReporter;
  /** Say something back to the owner in chat (already rate-limited + redacted). */
  readonly say: (message: string) => void;
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}