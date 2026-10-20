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
    const fought = wanted.length > 0 ? wanted : target.name;

    const deadline = Date.now() + ATTACK_DURATION_MS;
    let hits = 0;
    let ticks = 0;
    /** Set when the mob vanished (died or walked off) instead of being fought. */
    let targetLost = false;

    try {
      while (!ctx.signal.aborted && Date.now() < deadline) {
        ticks += 1;
        // The mob moves, so the position captured at the start is stale by
        // now: look it up again every tick and fight where it IS.
        let fresh = this.findTarget(radius, wanted, target);
        if (!fresh) {
          targetLost = true;
          break;
        }

        if (distance3(this.facade.getPosition(), fresh.position) > ENGAGE_RANGE) {
          const moved = await navigateToPosition(this.facade, ctx, fresh.position, {
            description: `Closing in on ${fresh.name}`,
            arriveDistance: ENGAGE_RANGE,
          });
          if (moved.status === 'cancelled') break;
          // Walking takes time and the mob keeps moving - it may even die
          // while the bot walks - so the position the walk aimed at is
          // stale by now: look the mob up again and fight where it IS.
          const current = this.findTarget(radius, wanted, target);
          if (!current) {
            targetLost = true;
            break;
          }
          fresh = current;
        }

        // Only swing at a mob that is within reach: the server ignores an
        // attack on a target that is too far away, so counting that swing
        // would report a hit that never landed.
        if (distance3(this.facade.getPosition(), fresh.position) > ENGAGE_RANGE) {
          reportProgress(ctx, ticks, null, `closing in on ${fresh.name}`);
          await sleep(ATTACK_TICK_MS, ctx.signal);
          continue;
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
        return { ok: false, detail: `Stopped fighting ${fought}.`, count: hits };
      }
      if (hits === 0) {
        // Nothing landed: say what happened instead of claiming a fight
        // that did not happen.
        if (targetLost) return failedResult(`The ${fought} is gone.`, 0);
        return failedResult(`I could not reach the ${fought}.`, 0);
      }
      return { ok: true, detail: `Fought ${fought} (${hits} swings).`, count: hits };
    } catch (error) {
      if (isCancellation(error)) {
        return { ok: false, detail: `Stopped fighting ${fought}.`, count: hits };
      }
      return failedResult(`Fighting ${fought} failed: ${describeError(error)}`, hits);
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
      .filter((entity) => isTheTarget(entity, wanted, anchor))
      .sort((a, b) => a.distance - b.distance);
    return candidates[0] ?? null;
  }
}

/**
 * Is this entity the one to fight?
 *
 * A requested name wins: "attack the skeleton" must not end up hitting the
 * creeper that happens to be closer. Without a name the fight stays on the
 * mob it started with.
 */
function isTheTarget(entity: EntitySummary, wanted: string, anchor?: EntitySummary): boolean {
  if (wanted.length > 0) return matchesName(entity, wanted);
  return anchor === undefined || matchesAnchor(entity, anchor);
}

/**
 * Does this entity carry the name that was asked for?
 *
 * The comparison ignores case and treats underscores and spaces as the same
 * thing, so "wither_skeleton" and "wither skeleton" name the same mob.
 */
function matchesName(entity: EntitySummary, wanted: string): boolean {
  return nameForms(entity.name).some((form) => nameForms(wanted).includes(form));
}

/**
 * The spellings one mob name can take.
 *
 * Minecraft names mobs in the singular ("zombie") while a player asks for
 * them in the plural ("zombies"), so the plural is folded back as well. Both
 * sides are folded, so "zombies" and "zombie" meet in the middle.
 */
function nameForms(name: string): string[] {
  const plain = name.trim().toLowerCase().replace(/_/g, ' ');
  const forms = [plain];
  // "witches" -> "witch", "vexes" -> "vex"
  if (plain.endsWith('es')) forms.push(plain.slice(0, -2));
  // "zombies" -> "zombie", "skeletons" -> "skeleton"
  if (plain.endsWith('s') && !plain.endsWith('ss')) forms.push(plain.slice(0, -1));
  return forms;
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
