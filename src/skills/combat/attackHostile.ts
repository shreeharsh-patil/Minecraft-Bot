/** Fight the nearest hostile mob (or one matching a name) for a short while. */
import type { MinecraftFacade } from '../../types/facade.js';
import type { EntitySummary } from '../../types/world.js';
import type { AttackParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import { distance3 } from '../../types/world.js';
import { sleep } from '../../utils/sleep.js';
import {
  clamp,
  describeError,
  failedResult,
  isCancellation,
  navigateToPosition,
  reportProgress,
  resolveEntityId,
} from '../internal/helpers.js';
import { isHostile } from '../survival/escapeDanger.js';

/** How long a single `attack_hostile` action runs before giving up. */
export const ATTACK_DURATION_MS = 15_000;
const ATTACK_TICK_MS = 500;
/** Keep attacking while within this range; otherwise close the distance. */
const ENGAGE_RANGE = 3;

export class AttackHostileSkill implements Skill<AttackParams> {
  public readonly name: ActionType = 'attack_hostile';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.COMBAT];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: AttackParams, ctx: ExecutionContext): Promise<SkillResult> {
    const radius = clamp(params.radius ?? 12, 2, 32);
    const wanted = typeof params.target === 'string' ? params.target.trim().toLowerCase() : '';

    if (ctx.signal.aborted) return { ok: false, detail: 'Cancelled before I attacked.', count: 0 };

    const candidates = this.facade
      .getNearbyEntities(radius)
      .filter((entity) => isHostile(entity))
      .filter((entity) => wanted.length === 0 || entity.name.toLowerCase() === wanted)
      .sort((a, b) => a.distance - b.distance);

    const target = candidates[0];
    if (!target) {
      return failedResult(
        wanted.length > 0 ? `I can't find a ${wanted} nearby.` : "There are no hostile mobs nearby.",
        0,
      );
    }

    const deadline = Date.now() + ATTACK_DURATION_MS;
    let hits = 0;
    let ticks = 0;

    try {
      while (!ctx.signal.aborted && Date.now() < deadline) {
        ticks += 1;
        // The mob may be gone; confirm it is still worth chasing.
        const stillThere = this.facade
          .getNearbyEntities(radius)
          .some((entity) => isHostile(entity) && matchesTarget(entity, target, wanted));
        if (!stillThere) break;

        const distance = distance3(this.facade.getPosition(), target.position);
        if (distance > ENGAGE_RANGE) {
          const moved = await navigateToPosition(this.facade, ctx, target.position, {
            description: `Closing in on ${target.name}`,
            arriveDistance: ENGAGE_RANGE,
          });
          if (moved.status === 'cancelled') break;
        }

        this.facade.lookAt(target.position, true);
        const id = resolveEntityId(target);
        if (id !== null) {
          this.facade.attackEntity(id);
          hits += 1;
        } else {
          // No id available on the summary: swing instead of inventing one.
          await this.facade.useItem();
          hits += 1;
        }

        reportProgress(ctx, ticks, null, `fighting ${target.name}`);
        await sleep(ATTACK_TICK_MS, ctx.signal);
      }

      if (ctx.signal.aborted) {
        return { ok: false, detail: `Stopped fighting ${target.name}.`, count: hits };
      }
      return { ok: hits > 0, detail: `Fought ${target.name} (${hits} swings).`, count: hits };
    } catch (error) {
      if (isCancellation(error)) {
        return { ok: false, detail: `Stopped fighting ${target.name}.`, count: hits };
      }
      return failedResult(`Fighting ${target.name} failed: ${describeError(error)}`, hits);
    }
  }
}

function matchesTarget(entity: EntitySummary, target: EntitySummary, wanted: string): boolean {
  if (wanted.length > 0) return entity.name.toLowerCase() === wanted;
  return entity.name === target.name;
}

export function createAttackHostileSkill(facade: MinecraftFacade): AttackHostileSkill {
  return new AttackHostileSkill(facade);
}