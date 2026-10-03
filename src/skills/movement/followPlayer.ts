/**
 * The continuous follow skill.
 *
 * Behaviour:
 *  - keeps a *band* around the player: never walks inside them, never tails
 *    them from across the map;
 *  - repaths only when the player has moved beyond
 *    `MOVEMENT.FOLLOW_REPATH_DISTANCE` from the current goal;
 *  - ticks on `MOVEMENT.FOLLOW_TICK_MS` and exits immediately on abort;
 *  - always calls `stopMoving()` on the way out so the bot never keeps walking
 *    after the task was stopped.
 */
import { MOVEMENT } from '../../config/constants.js';
import type { MinecraftFacade } from '../../types/facade.js';
import type { Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import type { Vec3Like } from '../../types/world.js';
import { distance3 } from '../../types/world.js';
import { createLogger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import {
  cancelledResult,
  clamp,
  describeError,
  failedResult,
  isCancellation,
  navigateToPlayer,
  navigateToPosition,
  reportProgress,
} from '../internal/helpers.js';

const log = createLogger({ level: 'info' }).child({ layer: 'skills', skill: 'follow_player' });

/**
 * `FollowPlayerParams` mirrors `FollowPlayerAction` from types/actions.ts.
 * Declared here because the frozen skill contract has no follow params type.
 */
export interface FollowPlayerParams {
  player: string;
  /** Stay within this distance; never walk inside the player. */
  distance?: number;
}

/** The bot never stands closer than this, whatever the model asks for. */
const MIN_FOLLOW_DISTANCE = MOVEMENT.FOLLOW_STOP_DISTANCE;
const MAX_FOLLOW_DISTANCE = 12;
/** Consecutive ticks with no sighting before we give up on the player. */
const MAX_MISSING_TICKS = 5;

export class FollowPlayerSkill implements Skill<FollowPlayerParams> {
  public readonly name: ActionType = 'follow_player';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.MOVEMENT];

  private readonly facade: MinecraftFacade;
  private readonly tickMs: number;

  constructor(facade: MinecraftFacade, tickMs: number = MOVEMENT.FOLLOW_TICK_MS) {
    this.facade = facade;
    this.tickMs = Math.max(50, tickMs);
  }

  public async execute(params: FollowPlayerParams, ctx: ExecutionContext): Promise<SkillResult> {
    const player = typeof params.player === 'string' ? params.player.trim() : '';
    if (player.length === 0) {
      return failedResult('I need to know which player to follow.', 0);
    }

    const stopDistance = clamp(params.distance ?? MOVEMENT.FOLLOW_STOP_DISTANCE, MIN_FOLLOW_DISTANCE, MAX_FOLLOW_DISTANCE);
    let goal: Vec3Like | null = null;
    let missingTicks = 0;
    let ticks = 0;

    try {
      while (!ctx.signal.aborted) {
        ticks += 1;
        const sighting = this.facade.getNearestPlayer(player);

        if (!sighting) {
          missingTicks += 1;
          if (goal !== null) {
            // Lost sight: hold position rather than walking to a stale goal.
            this.facade.stopMoving();
            goal = null;
          }
          if (missingTicks >= MAX_MISSING_TICKS) {
            return failedResult(`I lost sight of ${player} and stopped following.`, ticks);
          }
          ctx.say(`I can't see ${player} right now - waiting for them.`);
          await sleep(this.tickMs, ctx.signal);
          continue;
        }
        missingTicks = 0;

        const here = this.facade.getPosition();
        const distance = distance3(here, sighting.position);

        if (distance < MIN_FOLLOW_DISTANCE) {
          // Too close - shuffle back out to the edge of the band rather than
          // standing inside the player.
          const outcome = await navigateToPosition(this.facade, ctx, backOffTarget(here, sighting.position, stopDistance), {
            description: `Stepping back from ${player}`,
            arriveDistance: 0.5,
          });
          if (outcome.status === 'cancelled') break;
          reportProgress(ctx, ticks, null, `stepping back from ${player}`);
        } else if (distance <= stopDistance) {
          // Inside the band: stop moving so we never shuffle into the player.
          this.facade.stopMoving();
          goal = null;
          reportProgress(ctx, ticks, null, `holding position ${distance.toFixed(1)}m from ${player}`);
        } else {
          const needsRepath =
            goal === null || distance3(goal, sighting.position) > MOVEMENT.FOLLOW_REPATH_DISTANCE;

          if (needsRepath) {
            goal = { ...sighting.position };
            const outcome = await navigateToPlayer(this.facade, ctx, player, {
              description: `Following ${player}`,
              arriveDistance: stopDistance,
            });

            if (outcome.status === 'cancelled') break;
            if (outcome.status !== 'arrived') {
              // Blocked/unreachable: drop the goal and re-evaluate next tick
              // instead of hammering the same wall.
              goal = null;
              log.debug('follow repath failed', { player, reason: outcome.reason });
              if (outcome.status === 'unreachable') {
                return failedResult(`I can't reach ${player} right now.`, ticks);
              }
            }
          }
          reportProgress(ctx, ticks, null, `closing in on ${player}`);
        }

        await sleep(this.tickMs, ctx.signal);
      }

      return cancelledResult(`Stopped following ${player}.`, ticks);
    } catch (error) {
      if (isCancellation(error)) return cancelledResult(`Stopped following ${player}.`, ticks);
      log.error('follow failed', { player, error: describeError(error) });
      return failedResult(`Something went wrong while following ${player}: ${describeError(error)}`, ticks);
    } finally {
      // Always stop movement - a cancelled follow must not leave the bot walking.
      this.facade.stopMoving();
    }
  }
}

/**
 * A point `distance` blocks away from the player, on the bot's current side.
 * Deterministic when the two positions coincide.
 */
function backOffTarget(here: Vec3Like, playerPosition: Vec3Like, distance: number): Vec3Like {
  const dx = here.x - playerPosition.x;
  const dz = here.z - playerPosition.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.01) return { x: playerPosition.x + distance, y: here.y, z: playerPosition.z };
  return {
    x: playerPosition.x + (dx / length) * distance,
    y: here.y,
    z: playerPosition.z + (dz / length) * distance,
  };
}

export function createFollowPlayerSkill(facade: MinecraftFacade): FollowPlayerSkill {
  return new FollowPlayerSkill(facade);
}