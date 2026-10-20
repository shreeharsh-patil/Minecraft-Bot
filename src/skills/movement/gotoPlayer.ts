/** Walk to a player once, then stop. */
import { MOVEMENT } from '../../config/constants.js';
import type { MinecraftFacade } from '../../types/facade.js';
import type { GotoPlayerParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import {
  clamp,
  describeError,
  failedResult,
  isCancellation,
  navigateToPlayer,
} from '../internal/helpers.js';

export class GotoPlayerSkill implements Skill<GotoPlayerParams> {
  public readonly name: ActionType = 'move_to_player';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.MOVEMENT];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: GotoPlayerParams, ctx: ExecutionContext): Promise<SkillResult> {
    const player = typeof params.player === 'string' ? params.player.trim() : '';
    if (player.length === 0) {
      return failedResult('I need to know which player to walk to.', 0);
    }
    if (ctx.signal.aborted) {
      return { ok: false, detail: 'Cancelled before I started walking.' };
    }

    try {
      const arriveDistance = clamp(params.maxDistance ?? MOVEMENT.ARRIVE_DISTANCE, 0.5, 16);

      const sighting = this.facade.getNearestPlayer(player);
      if (!sighting) {
        return failedResult(`I can't find ${player}.`, 0);
      }
      if (sighting.distance <= arriveDistance) {
        return { ok: true, detail: `Already next to ${player}.` };
      }

      // The bot must never walk into a hazard. The `avoid` list the navigation
      // helper passes governs the ROUTE, not the destination: a cell that
      // holds lava, fire or a cactus hurts whoever stands in it, and the
      // danger rules say such blocks are never walked into.
      if (this.facade.isDangerous(sighting.position)) {
        const block = this.facade.getBlockAt(sighting.position);
        const hazard = block === null ? 'that spot' : `the ${block.replace(/_/g, ' ')}`;
        return failedResult(`I won't walk into ${hazard} to reach ${player}.`, 0);
      }

      const outcome = await navigateToPlayer(this.facade, ctx, player, {
        description: `Walking to ${player}`,
        arriveDistance,
      });

      switch (outcome.status) {
        case 'arrived':
          return { ok: true, detail: `Walked to ${player}.` };
        case 'cancelled':
          return { ok: false, detail: `Stopped while walking to ${player}.` };
        case 'unreachable':
          return failedResult(`I can't find a path to ${player}: ${outcome.reason}`, 0);
        default:
          return failedResult(`I got blocked on the way to ${player}: ${outcome.reason}`, 0);
      }
    } catch (error) {
      // A skill reports ordinary failures, it never throws them: the caller
      // is the executor, and a raw exception would reach the player as an
      // error message instead of an answer.
      if (isCancellation(error)) {
        return { ok: false, detail: `Stopped while walking to ${player}.`, count: 0 };
      }
      return failedResult(`Walking to ${player} failed: ${describeError(error)}`, 0);
    }
  }
}

export function createGotoPlayerSkill(facade: MinecraftFacade): GotoPlayerSkill {
  return new GotoPlayerSkill(facade);
}
