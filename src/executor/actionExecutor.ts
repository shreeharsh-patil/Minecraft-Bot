/**
 * Executes validated actions against the skill registry.
 *
 * Responsibilities:
 *  - map ActionType -> Skill via a registry (no giant switch);
 *  - enforce rate limits before every world-affecting action;
 *  - run each action inside a cancellable task;
 *  - stop the whole sequence the moment the plan is cancelled.
 */
import type { ActionType, BotAction } from '../types/actions.js';
import type { Skill, SkillResult } from '../types/skill.js';
import type { ExecutionContext, TaskConflictGroup } from '../types/task.js';
import { CONFLICT_GROUP } from '../types/task.js';
import type { MinecraftFacade } from '../types/facade.js';
import type { TaskManager, TaskHandle } from './actionQueue.js';
import type { ActionLimits } from '../safety/actionLimits.js';
import type { AntiGriefRules } from '../safety/antiGrief.js';
import type { Logger } from '../utils/logger.js';
import { AbortedError } from '../utils/sleep.js';

/** Which body-conflict group an action needs. */
const ACTION_CONFLICT_GROUP: Record<ActionType, string> = {
  move_to_player: CONFLICT_GROUP.MOVEMENT,
  move_to_position: CONFLICT_GROUP.MOVEMENT,
  follow_player: CONFLICT_GROUP.MOVEMENT,
  stop: CONFLICT_GROUP.NONE,
  look_at: CONFLICT_GROUP.NONE,
  wait: CONFLICT_GROUP.NONE,
  mine_block: CONFLICT_GROUP.MINING,
  collect_resource: CONFLICT_GROUP.MINING,
  place_block: CONFLICT_GROUP.BUILDING,
  build_structure: CONFLICT_GROUP.BUILDING,
  equip_item: CONFLICT_GROUP.INVENTORY,
  drop_item: CONFLICT_GROUP.INVENTORY,
  deposit_items: CONFLICT_GROUP.INVENTORY,
  withdraw_items: CONFLICT_GROUP.INVENTORY,
  // Walking onto the dropped stacks needs the body, so it claims movement.
  pickup_items: CONFLICT_GROUP.MOVEMENT,
  eat: CONFLICT_GROUP.NONE,
  attack_hostile: CONFLICT_GROUP.COMBAT,
  defend_player: CONFLICT_GROUP.COMBAT,
  // Pure chat: no body access, never blocks another action.
  say: CONFLICT_GROUP.NONE,
};

export interface ActionExecutorDeps {
  facade: MinecraftFacade;
  tasks: TaskManager;
  limits: ActionLimits;
  antiGrief: AntiGriefRules;
  logger: Logger;
  /** Maps ActionType -> skill. Injected so the executor stays testable. */
  registry: ReadonlyMap<ActionType, Skill<never>>;
  /** Sends a message back to a player, already redacted + rate-limited. */
  say: (target: string, message: string) => void;
}

export interface PlanOutcome {
  completed: string[];
  failed: Array<{ action: string; reason: string }>;
  cancelled: boolean;
}

export class ActionExecutor {
  private readonly deps: ActionExecutorDeps;
  private readonly logger: Logger;
  /** The plan currently executing, so `!stop` can abort it mid-sequence. */
  private activePlan: AbortController | null = null;

  constructor(deps: ActionExecutorDeps) {
    this.deps = deps;
    this.logger = deps.logger.child({ component: 'executor' });
  }

  /**
   * Runs a validated plan in order.
   *
   * Each action gets its own task (so conflict groups arbitrate correctly),
   * but the whole plan shares one abort signal so `!stop` halts everything.
   */
  async runPlan(owner: string, actions: BotAction[]): Promise<PlanOutcome> {
    const outcome: PlanOutcome = { completed: [], failed: [], cancelled: false };
    if (actions.length === 0) return outcome;

    // A new plan supersedes any plan already running.
    this.activePlan?.abort(new AbortedError('superseded by a new plan'));
    const planController = new AbortController();
    this.activePlan = planController;

    // Relay shutdown signals so a Ctrl+C stops the body cleanly.
    const onShutdown = (): void => planController.abort(new AbortedError('shutting down'));
    process.once('SIGINT', onShutdown);
    process.once('SIGTERM', onShutdown);

    try {
      for (const action of actions) {
        if (planController.signal.aborted) {
          outcome.cancelled = true;
          break;
        }
        // `stop` mid-plan ends the sequence immediately.
        if (action.type === 'stop') {
          outcome.completed.push('stop');
          outcome.cancelled = true;
          break;
        }

        const result = await this.runSingle(owner, action, planController.signal);
        if (result.cancelled) {
          outcome.cancelled = true;
          break;
        }
        if (result.ok) {
          outcome.completed.push(action.type);
        } else {
          outcome.failed.push({ action: action.type, reason: result.detail ?? 'failed' });
        }
      }
      return outcome;
    } finally {
      process.removeListener('SIGINT', onShutdown);
      process.removeListener('SIGTERM', onShutdown);
      if (this.activePlan === planController) this.activePlan = null;
    }
  }

/** Executes a single action. Used by both plans and deterministic commands. */
  async runSingle(
    owner: string,
    action: BotAction,
    signal?: AbortSignal,
  ): Promise<SkillResult & { cancelled: boolean }> {
    const skill = this.deps.registry.get(action.type);
    if (!skill) {
      return { ok: false, detail: `no skill registered for "${action.type}"`, cancelled: false };
    }

    const rate = this.deps.limits.checkRate();
    if (!rate.allowed) {
      return { ok: false, detail: rate.reason, cancelled: false };
    }

    const actionCheck = this.deps.limits.checkAction(
      action as BotAction & Record<string, unknown>,
    );
    if (!actionCheck.allowed) {
      return { ok: false, detail: actionCheck.reason, cancelled: false };
    }

    const conflictGroup: TaskConflictGroup =
      ACTION_CONFLICT_GROUP[action.type] ?? CONFLICT_GROUP.NONE;

    // Short-lived task handle so arbitration + cancellation work uniformly.
    const handle: TaskHandle = this.deps.tasks.start({
      owner,
      type: action.type,
      conflictGroup,
      steps: [action.type],
    });

    // Bridge the outer plan signal into this task's signal.
    const relay = (): void => handle.cancel('plan cancelled');
    signal?.addEventListener('abort', relay, { once: true });

    const ctx: ExecutionContext = {
      task: handle.record,
      signal: handle.signal,
      progress: (p) => {
        handle.record.progress = { ...handle.record.progress, ...p };
      },
      say: (message) => {
        this.deps.say(owner, message);
      },
    };

    try {
      const result = (await (skill as Skill<BotAction>).execute(action, ctx));
      this.deps.tasks.complete(handle.record.id, result.ok ? 'completed' : 'failed', result.detail);
      return { ...result, cancelled: false };
    } catch (error) {
      const cancelled = handle.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      if (cancelled) {
        this.deps.tasks.cancel(handle.record.id, 'aborted');
        // Always halt the body when a task is cancelled.
        this.deps.facade.stopMoving();
        return { ok: false, detail: 'cancelled', cancelled: true };
      }
      this.deps.tasks.complete(handle.record.id, 'failed', message);
      this.logger.error('action failed', { action: action.type, error: message });
      return { ok: false, detail: message, cancelled: false };
    } finally {
      signal?.removeEventListener('abort', relay);
    }
  }

  /** Aborts the plan in flight. Wired directly to `!stop`. */
  cancelActivePlan(reason = 'stopped'): boolean {
    if (!this.activePlan) return false;
    this.logger.info('cancelling active plan', { reason });
    this.activePlan.abort(new AbortedError(reason));
    this.deps.facade.stopMoving();
    return true;
  }

  hasActivePlan(): boolean {
    return this.activePlan !== null;
  }
}

export { ACTION_CONFLICT_GROUP };
