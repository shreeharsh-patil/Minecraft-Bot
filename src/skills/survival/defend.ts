/**
 * Guard a player: stay near them and attack anything hostile that closes in.
 *
 * Runs until `ctx.signal` aborts or the (always bounded) duration elapses.
 * Always stops moving on the way out, and never throws for ordinary combat
 * conditions.
 */
import { MOVEMENT } from '../../config/constants.js';
import type { MinecraftFacade } from '../../types/facade.js';
import type { EntitySummary } from '../../types/world.js';
import type { DefendParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import { distance3 } from '../../types/world.js';
import { MAX_DEFEND_DURATION_MS } from '../../safety/actionLimits.js';
import { createLogger } from '../../utils/logger.js';
import { sleep } from '../../utils/sleep.js';
import {
  ChatGate,
  clamp,
  describeError,
  failedResult,
  isCancellation,
  navigateToPlayer,
  reportProgress,
  resolveEntityId,
} from '../internal/helpers.js';
import { ESCAPE_DISTANCE, ESCAPE_RADIUS, EscapeDangerSkill, isHostile, needsEscape } from './escapeDanger.js';

const log = createLogger({ level: 'info' }).child({ layer: 'skills', skill: 'defend' });

/** How often the guard re-scans for threats. */
const GUARD_TICK_MS = 500;
/** Beyond this range from the guarded player, the guard walks back. */
const DEFAULT_GUARD_RADIUS = 8;
/** Attack range. */
const ATTACK_RANGE = 3;
/**
 * How long a guard runs when the action does not say.
 *
 * A guard with no deadline would keep the combat conflict group claimed for
 * ever and the player would never get a result. A minute is long enough to
 * cover a fight and short enough to end on its own.
 */
export const DEFAULT_DEFEND_DURATION_MS = 60_000;
/** At most one chat line per interval: servers punish repeated spam. */
const CHAT_INTERVAL_MS = 10_000;

export class DefendSkill implements Skill<DefendParams> {
  public readonly name: ActionType = 'defend_player';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.COMBAT, CONFLICT_GROUP.MOVEMENT];

  private readonly escape: EscapeDangerSkill;

  constructor(private readonly facade: MinecraftFacade) {
    this.escape = new EscapeDangerSkill(facade);
  }

  public async execute(params: DefendParams, ctx: ExecutionContext): Promise<SkillResult> {
    const player = typeof params.player === 'string' ? params.player.trim() : '';
    if (player.length === 0) {
      return failedResult('I need to know who to guard.', 0);
    }
    const radius = clamp(params.radius ?? DEFAULT_GUARD_RADIUS, 2, 24);
    // The duration is always bounded: an unbounded guard would never let go
    // of the combat conflict group.
    const durationMs = clamp(
      params.durationMs ?? DEFAULT_DEFEND_DURATION_MS,
      0,
      MAX_DEFEND_DURATION_MS,
    );
    const deadline = Date.now() + durationMs;
    const chat = new ChatGate(CHAT_INTERVAL_MS);

    let attacked = 0;
    let ticks = 0;

    try {
      while (!ctx.signal.aborted) {
        if (Date.now() >= deadline) break;
        ticks += 1;

        // The escape reflex comes first: standing in lava outranks guarding.
        if (needsEscape(this.facade, ESCAPE_RADIUS)) {
          const escaped = await this.escape.execute(
            { radius: ESCAPE_RADIUS, distance: ESCAPE_DISTANCE },
            ctx,
          );
          if (!escaped.ok) {
            log.warn('escape reflex failed', { player, detail: escaped.detail });
          }
          await sleep(GUARD_TICK_MS, ctx.signal);
          continue;
        }

        const sighting = this.facade.getNearestPlayer(player);
        if (!sighting) {
          this.facade.stopMoving();
          // Rate limited: the same line twice a second would be chat spam.
          chat.speak(ctx, `I can't see ${player} - I'm holding position.`);
          await sleep(GUARD_TICK_MS, ctx.signal);
          continue;
        }

        // Threat = hostile within `radius` of the guarded player.
        const threats = this.facade
          .getNearbyEntities(radius * 2)
          .filter((entity) => isHostile(entity) && distance3(entity.position, sighting.position) <= radius)
          .sort((a, b) => distance3(a.position, sighting.position) - distance3(b.position, sighting.position));

        const nearest = threats[0];
        if (nearest) {
          const outcome = await this.engage(nearest, ctx);
          if (outcome === 'cancelled') break;
          if (outcome === 'attacked') attacked += 1;
        }

        // Otherwise stay in position near the player.
        const fromPlayer = distance3(this.facade.getPosition(), sighting.position);
        if (fromPlayer > radius) {
          const moved = await navigateToPlayer(this.facade, ctx, player, {
            description: `Returning to ${player}`,
            arriveDistance: MOVEMENT.FOLLOW_STOP_DISTANCE,
          });
          if (moved.status === 'cancelled') break;
        } else {
          this.facade.stopMoving();
          // Keep eyes on the player.
          this.facade.lookAt(sighting.position);
        }

        reportProgress(ctx, ticks, null, `guarding ${player}`);
        await sleep(GUARD_TICK_MS, ctx.signal);
      }

      if (ctx.signal.aborted) {
        return { ok: false, detail: `Stopped guarding ${player}.`, count: attacked };
      }
      return { ok: true, detail: `Guarded ${player} (${attacked} attacks).`, count: attacked };
    } catch (error) {
      if (isCancellation(error)) {
        return { ok: false, detail: `Stopped guarding ${player}.`, count: attacked };
      }
      log.error('defend failed', { player, error: describeError(error) });
      return failedResult(`Guarding ${player} failed: ${describeError(error)}`, attacked);
    } finally {
      this.facade.stopMoving();
    }
  }

  /**
   * Turns to the threat and hits it.
   * Returns 'cancelled' | 'attacked' | 'missed'.
   */
  private async engage(target: EntitySummary, ctx: ExecutionContext): Promise<'cancelled' | 'attacked' | 'missed'> {
    if (ctx.signal.aborted) return 'cancelled';
    if (distance3(this.facade.getPosition(), target.position) > ATTACK_RANGE * 2) return 'missed';

    this.facade.lookAt(target.position, true);
    const id = resolveEntityId(target);
    if (id === null) {
      // The facade summary carries no id; swing anyway and report honestly.
      log.debug('no entity id available; swinging', { target: target.name });
      await this.useWeapon(ctx);
      return 'attacked';
    }
    this.facade.attackEntity(id);
    return 'attacked';
  }

  private async useWeapon(ctx: ExecutionContext): Promise<void> {
    if (ctx.signal.aborted) return;
    const held = this.facade.heldItem();
    if (held === null || !held.includes('sword')) {
      const weapon = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword'].find(
        (candidate) => this.facade.countItem(candidate) > 0,
      );
      if (weapon !== undefined) {
        await this.facade.equipItem(weapon);
      }
    }
    // A swing keeps the guard facing and attacking even without an entity id.
    await this.facade.useItem();
  }
}

export function createDefendSkill(facade: MinecraftFacade): DefendSkill {
  return new DefendSkill(facade);
}
