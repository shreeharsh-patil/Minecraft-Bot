/**
 * Eat when hungry (or on request), choosing the best food the bot carries.
 */
import { FOODS } from '../../config/constants.js';
import type { MinecraftFacade } from '../../types/facade.js';
import type { EatParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import { describeError, failedResult, guardedOp, isCancellation, normaliseBlockName } from '../internal/helpers.js';

/** Hunger at or below this level counts as "should eat now". */
export const HUNGER_THRESHOLD = 17;

export class AutoEatSkill implements Skill<EatParams> {
  public readonly name: ActionType = 'eat';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.NONE];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: EatParams, ctx: ExecutionContext): Promise<SkillResult> {
    const explicit = normaliseBlockName(params.item ?? '');
    const hunger = this.facade.getHunger();

    let food: string | null;
    if (explicit.length > 0) {
      food = explicit;
    } else {
      // "At or below" the threshold counts as hungry, so the comparison has
      // to be strict: at exactly HUNGER_THRESHOLD the bot still eats.
      if (hunger.current > HUNGER_THRESHOLD) {
        return { ok: true, detail: `I'm not hungry (${Math.round(hunger.current)}/20).`, count: 0 };
      }
      food = this.pickFood();
      if (food === null) {
        return failedResult("I'm hungry but I have no food.", 0);
      }
    }

    if (this.facade.countItem(food) <= 0) {
      return failedResult(`I don't have any ${food.replace(/_/g, ' ')}.`, 0);
    }

    try {
      const eaten = await guardedOp(() => this.facade.eat(food), ctx, `Eating ${food}`);
      if (eaten.status === 'cancelled') {
        return { ok: false, detail: 'Stopped before I finished eating.', count: 0 };
      }
      if (eaten.status === 'error') {
        return failedResult(eaten.reason, 0);
      }
      if (!eaten.value) {
        return failedResult(`I couldn't eat the ${food.replace(/_/g, ' ')}.`, 0);
      }

      const after = this.facade.getHunger();
      return {
        ok: true,
        detail: `Ate ${food.replace(/_/g, ' ')} (hunger now ${Math.round(after.current)}/20).`,
        count: 1,
      };
    } catch (error) {
      if (isCancellation(error)) {
        return { ok: false, detail: 'Stopped while eating.', count: 0 };
      }
      return failedResult(`Eating failed: ${describeError(error)}`, 0);
    }
  }

  /** Best available food from `FOODS` (ordered best first). */
  private pickFood(): string | null {
    for (const candidate of FOODS) {
      if (this.facade.countItem(candidate) > 0) return candidate;
    }
    return null;
  }
}

export function createAutoEatSkill(facade: MinecraftFacade): AutoEatSkill {
  return new AutoEatSkill(facade);
}