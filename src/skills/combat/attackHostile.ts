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

    const target = this.findTarget(radius, wanted);
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
        // The mob moves, so the position captured at the start is stale by
        // now: look it up again every tick and fight where it IS.
        const fresh = this.findTarget(radius, wanted, target);
        if (!fresh) break;

        const distance = distance3(this.facade.getPosition(), fresh.position);
        if (distance > ENGAGE_RANGE) {
          const moved = await navigateToPosition(this.facade, ctx, fresh.position, {
            description: `Closing in on ${fresh.name}`,
            arriveDistance: ENGAGE_RANGE,
          });
          if (moved.status === 'cancelled') break;
        }

        this.facade.lookAt(fresh.position, true);
        const id = resolveEntityId(fresh);
        if (id !== null) {
          this.facade.attackEntity(id);
          hits += 1;
        } else {
          // No id available on the summary: swing instead of inventing one.
          await this.facade.useItem();
          hits += 1;
        }

        reportProgress(ctx, ticks, null, `fighting ${fresh.name}`);
        await sleep(ATTACK_TICK_MS, ctx.signal);
      }

      if (ctx.signal.aborted) {
        return { ok: false, detail: `Stopped fighting ${wanted.length > 0 ? wanted : target.name}.`, count: hits };
      }
      return { ok: hits > 0, detail: `Fought ${wanted.length > 0 ? wanted : target.name} (${hits} swings).`, count: hits };
    } catch (error) {
      if (isCancellation(error)) {
        return { ok: false, detail: `Stopped fighting ${wanted.length > 0 ? wanted : target.name}.`, count: hits };
      }
      return failedResult(`Fighting ${wanted.length > 0 ? wanted : target.name} failed: ${describeError(error)}`, hits);
    }
  }

  /**
   * Finds the mob to fight, fresh from the world.
   *
   * `anchor` is the mob the fight started with: when it carries an entity
   * id that id identifies the mob, so a different zombie is not attacked in
   * its place. Without an id the mob is identified by name.
   */
  private findTarget(
    radius: number,
    wanted: string,
    anchor?: EntitySummary,
  ): EntitySummary | null {
    const candidates = this.facade
      .getNearbyEntities(radius)
      .filter((entity) => isHostile(entity))
      .filter((entity) => wanted.length > 0 || anchor === undefined || matchesAnchor(entity, anchor))
      .sort((a, b) => a.distance - b.distance);
    return candidates[0] ?? null;
  }
}

/**
 * Is this entity the one the fight started with?
 *
 * An entity id identifies a mob exactly. Without one the name is the best
 * available handle - and it is only used when no name was requested.
 */
function matchesAnchor(entity: EntitySummary, anchor: EntitySummary): boolean {
  const anchorId = resolveEntityId(anchor);
  if (anchorId !== null) {
    const entityId = resolveEntityId(entity);
    if (entityId !== null) return entityId === anchorId;
  }
  return entity.name === anchor.name;
}

export function createAttackHostileSkill(facade: MinecraftFacade): AttackHostileSkill {
  return new AttackHostileSkill(facade);
}
