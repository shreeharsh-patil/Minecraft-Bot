/**
 * Hard ceilings on what the bot may do, independent of what the model asks for.
 * Every limit is a defence against runaway or hallucinated plans.
 */
import type { ActionType } from '../types/actions.js';
import type { SafetyConfig } from '../config/config.js';

export interface LimitDecision {
  allowed: boolean;
  reason?: string;
}

/** Per-task ceilings and absolute sanity bounds. */
export const DEFAULT_MAX_MINE = 512;
export const DEFAULT_MAX_BUILD = 256;
export const DEFAULT_MAX_WAIT_MS = 30_000;
export const MAX_PLANNED_ACTIONS = 64;
export const MAX_DROP_COUNT = 64;
export const MAX_BUILD_DIMENSION = 32;
/**
 * Longest a single guard/follow action may run.
 *
 * The validator and the executor share these numbers, so a plan that passes
 * validation is a plan the executor will not refuse for being too long.
 */
export const MAX_DEFEND_DURATION_MS = 600_000;
export const MAX_FOLLOW_DURATION_MS = 600_000;

export class ActionLimits {
  private readonly perMinute: number;
  private readonly maxMine: number;
  private readonly maxBuild: number;
  /** Sliding window of action timestamps. */
  private window: number[] = [];
  private miningThisTask = 0;
  private buildingThisTask = 0;

  constructor(config: SafetyConfig) {
    this.perMinute = config.maxActionsPerMinute;
    this.maxMine = config.maxMiningBlocksPerTask;
    this.maxBuild = config.maxBuildBlocksPerTask;
  }

  /** Global action budget. `0` disables the limit. */
  checkRate(): LimitDecision {
    if (this.perMinute <= 0) return { allowed: true };
    const now = Date.now();
    this.window = this.window.filter((t) => now - t < 60_000);
    if (this.window.length >= this.perMinute) {
      return { allowed: false, reason: `action rate limit reached (${this.perMinute}/min)` };
    }
    this.window.push(now);
    return { allowed: true };
  }

  clampMineCount(requested: number): number {
    const n = Number.isFinite(requested) ? Math.floor(requested) : 0;
    return Math.max(0, Math.min(n, this.maxMine));
  }

  clampBuildCount(requested: number): number {
    const n = Number.isFinite(requested) ? Math.floor(requested) : 0;
    return Math.max(0, Math.min(n, this.maxBuild));
  }

  recordMining(count = 1): LimitDecision {
    this.miningThisTask += count;
    if (this.miningThisTask > this.maxMine) {
      return { allowed: false, reason: `mining limit exceeded (${this.maxMine} blocks per task)` };
    }
    return { allowed: true };
  }

  recordBuilding(count = 1): LimitDecision {
    this.buildingThisTask += count;
    if (this.buildingThisTask > this.maxBuild) {
      return { allowed: false, reason: `building limit exceeded (${this.maxBuild} blocks per task)` };
    }
    return { allowed: true };
  }

  resetTaskCounters(): void {
    this.miningThisTask = 0;
    this.buildingThisTask = 0;
  }

  /** The configured per-task mining ceiling. */
  miningCeiling(): number {
    return this.maxMine;
  }

  /** The configured per-task building ceiling. */
  buildingCeiling(): number {
    return this.maxBuild;
  }

  /** Mining budget still available in this task. */
  remainingMining(): number {
    return Math.max(0, this.maxMine - this.miningThisTask);
  }

  /** Building budget still available in this task. */
  remainingBuilding(): number {
    return Math.max(0, this.maxBuild - this.buildingThisTask);
  }

/** Per-action sanity checks applied after allowlist validation. */
  checkAction(action: { type: ActionType } & Record<string, unknown>): LimitDecision {
    switch (action.type) {
      case 'wait': {
        const ms = Number(action['durationMs'] ?? 0);
        if (!Number.isFinite(ms) || ms < 0) return { allowed: false, reason: 'invalid wait duration' };
        if (ms > DEFAULT_MAX_WAIT_MS) return { allowed: false, reason: 'wait too long' };
        return { allowed: true };
      }
      case 'mine_block':
      case 'collect_resource': {
        const count = Number(action['count'] ?? 0);
        if (!Number.isFinite(count) || count <= 0) {
          return { allowed: false, reason: 'count must be a positive number' };
        }
        if (count > this.maxMine) {
          return { allowed: false, reason: `requested ${count} exceeds per-task limit ${this.maxMine}` };
        }
        return { allowed: true };
      }
      case 'drop_item': {
        const count = Number(action['count'] ?? MAX_DROP_COUNT);
        if (!Number.isFinite(count) || count < 0) return { allowed: false, reason: 'invalid count' };
        if (count > MAX_DROP_COUNT) return { allowed: false, reason: `drop count exceeds ${MAX_DROP_COUNT}` };
        return { allowed: true };
      }
      case 'move_to_position':
      case 'place_block': {
        const pos = action['position'] as { x?: unknown; y?: unknown; z?: unknown } | undefined;
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.z !== 'number') {
          return { allowed: false, reason: 'position must have numeric x, y and z' };
        }
        if (![pos.x, pos.y, pos.z].every((n) => Number.isFinite(n))) {
          return { allowed: false, reason: 'position must be finite' };
        }
        // World border guard - also catches nonsense coordinates.
        if (Math.abs(pos.x) > 30_000_000 || Math.abs(pos.z) > 30_000_000 || Math.abs(pos.y) > 20_000_000) {
          return { allowed: false, reason: 'position is outside the world border' };
        }
        return { allowed: true };
      }
      case 'build_structure': {
        const dims = action['dimensions'] as Record<string, unknown> | undefined;
        if (!dims) return { allowed: false, reason: 'build_structure requires dimensions' };
        for (const value of Object.values(dims)) {
          const n = Number(value);
          if (!Number.isFinite(n) || n <= 0) return { allowed: false, reason: 'invalid dimension' };
          if (n > MAX_BUILD_DIMENSION) {
            return { allowed: false, reason: `dimension exceeds ${MAX_BUILD_DIMENSION}` };
          }
        }
        const volume = Object.values(dims).reduce<number>((sum, v) => sum * Number(v), 1);
        if (volume > this.maxBuild) {
          return { allowed: false, reason: `structure volume ${volume} exceeds limit ${this.maxBuild}` };
        }
        return { allowed: true };
      }
      case 'defend_player': {
        const duration = action['durationMs'];
        if (duration !== undefined) {
          const ms = Number(duration);
          if (!Number.isFinite(ms) || ms <= 0) return { allowed: false, reason: 'invalid duration' };
          if (ms > MAX_DEFEND_DURATION_MS) return { allowed: false, reason: 'defend duration too long' };
        }
        return { allowed: true };
      }
      case 'follow_player': {
        const duration = action['durationMs'];
        if (duration !== undefined) {
          const ms = Number(duration);
          if (!Number.isFinite(ms) || ms <= 0) return { allowed: false, reason: 'invalid duration' };
          if (ms > MAX_FOLLOW_DURATION_MS) return { allowed: false, reason: 'follow duration too long' };
        }
        return { allowed: true };
      }
      default:
        return { allowed: true };
    }
  }

  snapshot(): { miningThisTask: number; buildingThisTask: number; recentActions: number } {
    return {
      miningThisTask: this.miningThisTask,
      buildingThisTask: this.buildingThisTask,
      recentActions: this.window.length,
    };
  }
}