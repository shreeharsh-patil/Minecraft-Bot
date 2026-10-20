/** Walk to an explicit position, then stop. */
import { MOVEMENT } from '../../config/constants.js';
import type { MinecraftFacade } from '../../types/facade.js';
import type { GotoPositionParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import type { Vec3Like } from '../../types/world.js';
import { distance3 } from '../../types/world.js';
import {
  clamp,
  describeError,
  failedResult,
  formatPos,
  isCancellation,
  navigateToPosition,
} from '../internal/helpers.js';

function isFiniteVec(value: Vec3Like | undefined): value is Vec3Like {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

export class GotoPositionSkill implements Skill<GotoPositionParams> {
  public readonly name: ActionType = 'move_to_position';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.MOVEMENT];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: GotoPositionParams, ctx: ExecutionContext): Promise<SkillResult> {
    if (!isFiniteVec(params.position)) {
      return failedResult('That position is not valid coordinates.', 0);
    }
    if (ctx.signal.aborted) {
      return { ok: false, detail: 'Cancelled before I started walking.' };
    }

    try {
      const target: Vec3Like = { x: params.position.x, y: params.position.y, z: params.position.z };
      const arriveDistance = clamp(params.maxDistance ?? MOVEMENT.ARRIVE_DISTANCE, 0.5, 16);
      const distance = distance3(this.facade.getPosition(), target);

      if (distance <= arriveDistance) {
        return { ok: true, detail: 'Already there.' };
      }

      // The bot must never walk into a hazard. The `avoid` list the navigation
      // helper passes governs the ROUTE, not the destination: a cell that
      // holds lava, fire or a cactus hurts whoever stands in it, and the
      // danger rules say such blocks are never walked into.
      if (this.facade.isDangerous(target)) {
        const block = this.facade.getBlockAt(target);
        const hazard = block === null ? 'that spot' : `the ${block.replace(/_/g, ' ')}`;
        return failedResult(`I won't walk into ${hazard} at ${formatPos(target)}.`, 0);
      }

      const outcome = await navigateToPosition(this.facade, ctx, target, {
        description: 'Walking to position',
        arriveDistance,
      });

      switch (outcome.status) {
        case 'arrived':
          return { ok: true, detail: 'Walked to the spot.' };
        case 'cancelled':
          return { ok: false, detail: 'Stopped while walking.' };
        case 'unreachable':
          return failedResult(`I can't find a path there: ${outcome.reason}`, 0);
        default:
          return failedResult(`I got blocked on the way: ${outcome.reason}`, 0);
      }
    } catch (error) {
      // A skill reports ordinary failures, it never throws them: the caller
      // is the executor, and a raw exception would reach the player as an
      // error message instead of an answer.
      if (isCancellation(error)) {
        return { ok: false, detail: 'Stopped while walking.', count: 0 };
      }
      return failedResult(`Walking to the spot failed: ${describeError(error)}`, 0);
    }
  }
}

export function createGotoPositionSkill(facade: MinecraftFacade): GotoPositionSkill {
  return new GotoPositionSkill(facade);
}
