/**
 * Executes validated actions against the skill registry.
 *
 * Responsibilities:
 *  - map ActionType -> Skill via a registry (no giant switch);
 *  - validate every action before it can touch the world;
 *  - enforce rate limits and per-task ceilings before every world-affecting
 *    action;
 *  - run each action inside a cancellable task;
 *  - stop the whole sequence the moment the plan is cancelled.
 */
import type { ActionType, BotAction } from '../types/actions.js';
import type { Skill, SkillResult } from '../types/skill.js';
import type { ExecutionContext, TaskConflictGroup } from '../types/task.js';
import { CONFLICT_GROUP } from '../types/task.js';
import type { MinecraftFacade } from '../types/facade.js';
import type { TaskManager, TaskHandle } from './actionQueue.js';
import type { ActionLimits, LimitDecision } from '../safety/actionLimits.js';
import type { AntiGriefRules } from '../safety/antiGrief.js';
import type { Logger } from '../utils/logger.js';
import { AbortedError } from '../utils/sleep.js';
import { validateAction } from './validator.js';

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

    // The per-task ceilings (blocks mined / placed) start fresh with every
    // plan, and are booked up as the plan runs.
    this.deps.limits.resetTaskCounters();

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
        // `stop` mid-plan ends the sequence immediately - and the body really
        // stops: the registered stop skill is what halts the movement.
        if (action.type === 'stop') {
          const stopped = await this.execute(owner, action, planController.signal, false);
          if (stopped.ok) {
            outcome.completed.push('stop');
          } else {
            // Even without a stop skill the body must not keep walking.
            this.deps.facade.stopMoving();
            outcome.failed.push({ action: 'stop', reason: stopped.detail ?? 'failed' });
          }
          outcome.cancelled = true;
          break;
        }

        const result = await this.execute(owner, action, planController.signal, false);
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
    // A standalone action is its own task, so the per-task ceilings start
    // fresh here as well.
    return this.execute(owner, action, signal, true);
  }

  /**
   * The one place an action becomes a world change.
   *
   * `resetCounters` is false for the actions of a plan (the plan reset the
   * per-task counters once, at its start) and true for a standalone action.
   */
  private async execute(
    owner: string,
    action: BotAction,
    signal: AbortSignal | undefined,
    resetCounters: boolean,
  ): Promise<SkillResult & { cancelled: boolean }> {
    // THE chokepoint: nothing reaches a skill without passing the shared
    // validator, whichever path produced the action - the model, the
    // deterministic command parser or a direct caller.
    const validation = validateAction(action);
    if (!validation.valid || validation.action === undefined) {
      const reason = validation.reason ?? 'invalid action';
      this.logger.warn('rejected invalid action', { action: action.type, reason });
      return { ok: false, detail: reason, cancelled: false };
    }
    // The validated action is the one that runs: unknown keys are stripped
    // and every field is in its canonical shape.
    const validated = validation.action;

    const skill = this.deps.registry.get(validated.type);
    if (!skill) {
      return { ok: false, detail: `no skill registered for "${validated.type}"`, cancelled: false };
    }

    const rate = this.deps.limits.checkRate();
    if (!rate.allowed) {
      return { ok: false, detail: rate.reason, cancelled: false };
    }

    const actionCheck = this.deps.limits.checkAction(
      validated as BotAction & Record<string, unknown>,
    );
    if (!actionCheck.allowed) {
      return { ok: false, detail: actionCheck.reason, cancelled: false };
    }

    const grief = this.checkAntiGrief(validated);
    if (!grief.allowed) {
      return { ok: false, detail: grief.reason, cancelled: false };
    }

    if (resetCounters) this.deps.limits.resetTaskCounters();
    const budget = this.checkBudget(validated);
    if (!budget.allowed) {
      return { ok: false, detail: budget.reason, cancelled: false };
    }

    const conflictGroup: TaskConflictGroup =
      ACTION_CONFLICT_GROUP[validated.type] ?? CONFLICT_GROUP.NONE;

    // Short-lived task handle so arbitration + cancellation work uniformly.
    const handle: TaskHandle = this.deps.tasks.start({
      owner,
      type: validated.type,
      conflictGroup,
      steps: [validated.type],
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
      const result = (await (skill as Skill<BotAction>).execute(validated, ctx));
      this.deps.tasks.complete(handle.record.id, result.ok ? 'completed' : 'failed', result.detail);
      this.recordUsage(validated, result);
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
      this.logger.error('action failed', { action: validated.type, error: message });
      return { ok: false, detail: message, cancelled: false };
    } finally {
      signal?.removeEventListener('abort', relay);
    }
  }

  /**
   * The anti-grief rules that can be decided from the action alone.
   *
   * The position-level rules ("is this block a player's?", "is that chest
   * theirs?") are enforced by the skills, which are the ones that know the
   * world. What the executor can do is refuse a request for a block type
   * that must never be broken, before any of it happens.
   */
  private checkAntiGrief(action: BotAction): LimitDecision {
    if (action.type !== 'mine_block') return { allowed: true };
    const decision = this.deps.antiGrief.canBreakBlock(action.blockName, this.deps.facade.getPosition());
    if (decision.allowed) return decision;
    return { allowed: false, reason: decision.reason ?? 'refusing to break that block' };
  }

  /**
   * The per-task ceilings: one plan may not mine or place more blocks than
   * the budget allows, no matter how the steps are split up.
   */
  private checkBudget(action: BotAction): LimitDecision {
    switch (action.type) {
      case 'mine_block':
      case 'collect_resource': {
        const remaining = this.deps.limits.remainingMining();
        if (remaining <= 0) {
          return {
            allowed: false,
            reason: `mining limit reached for this task (${this.deps.limits.miningCeiling()} blocks)`,
          };
        }
        if (action.count > remaining) {
          return {
            allowed: false,
            reason: `only ${remaining} more blocks may be mined in this task (limit ${this.deps.limits.miningCeiling()})`,
          };
        }
        return { allowed: true };
      }
      case 'place_block': {
        if (this.deps.limits.remainingBuilding() <= 0) {
          return {
            allowed: false,
            reason: `building limit reached for this task (${this.deps.limits.buildingCeiling()} blocks)`,
          };
        }
        return { allowed: true };
      }
      case 'build_structure': {
        const volume = Object.values(action.dimensions).reduce((sum, n) => sum * n, 1);
        const remaining = this.deps.limits.remainingBuilding();
        if (volume > remaining) {
          return {
            allowed: false,
            reason: `structure of ${volume} blocks exceeds the remaining build budget (${remaining})`,
          };
        }
        return { allowed: true };
      }
      default:
        return { allowed: true };
    }
  }

  /** Books what an action actually did against the per-task ceilings. */
  private recordUsage(action: BotAction, result: SkillResult): void {
    const count = result.count ?? 0;
    if (count <= 0) return;
    if (action.type === 'mine_block' || action.type === 'collect_resource') {
      const decision = this.deps.limits.recordMining(count);
      if (!decision.allowed) {
        this.logger.warn('mining ceiling reached', { reason: decision.reason });
      }
    }
    if (action.type === 'place_block' || action.type === 'build_structure') {
      const decision = this.deps.limits.recordBuilding(count);
      if (!decision.allowed) {
        this.logger.warn('building ceiling reached', { reason: decision.reason });
      }
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
