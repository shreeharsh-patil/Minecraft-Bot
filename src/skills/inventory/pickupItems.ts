/**
 * `pickup_items`: collect dropped items (a player's discarded stack, a death
 * pile, items spilled by a chest) from the ground.
 *
 * Minecraft's own pickup mechanic does the collecting - the bot only has to
 * walk onto the items. This skill therefore:
 *  - scans for dropped item entities in a bounded radius;
 *  - walks to the nearest candidate and skips piles that turned out to be
 *    unreachable instead of hammering the same hole forever;
 *  - stops as soon as the requested count is satisfied, or nothing is left;
 *  - reports the *inventory delta*, not the number of piles visited, so the
 *    number the player sees in chat is truthful.
 */
import type { MinecraftFacade } from '../../types/facade.js';
import type { Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import {
  clamp,
  cancelledResult,
  failedResult,
  isCancellation,
  normaliseBlockName,
  navigateToPosition,
  posKey,
  reportProgress,
} from '../internal/helpers.js';

/**
 * Mirrors `PickupItemsAction` from types/actions.ts. Declared here because the
 * frozen skill contract carries no parameter type for it.
 */
export interface PickupItemsParams {
  /** Only collect this item. Omitted means anything within range. */
  item?: string;
  /** Stop after this many items. Omitted means collect everything in range. */
  count?: number;
  /** Search radius in blocks. */
  radius?: number;
}

const DEFAULT_RADIUS = 8;
const MAX_RADIUS = 32;
/** A whole inventory's worth: more than this can never be carried. */
const MAX_PICKUPS = 2304;
/** Close enough for Minecraft's 1-block pickup radius to trigger. */
const ARRIVE_DISTANCE = 1;
/** Failed piles tolerated before we conclude the rest are unreachable too. */
const MAX_FAILURES = 3;
/** Absolute ceiling on walk attempts, so a jittery server cannot loop us. */
const MAX_ATTEMPTS = 24;

export class PickupItemsSkill implements Skill<PickupItemsParams> {
  public readonly name: ActionType = 'pickup_items';
  /** Walking to the items needs the body, like any other movement task. */
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.MOVEMENT];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: PickupItemsParams, ctx: ExecutionContext): Promise<SkillResult> {
    const item =
      typeof params.item === 'string' && params.item.trim().length > 0
        ? normaliseBlockName(params.item)
        : null;
    const wanted =
      typeof params.count === 'number' && Number.isFinite(params.count)
        ? clamp(Math.floor(params.count), 1, MAX_PICKUPS)
        : null;
    const radius = clamp(params.radius ?? DEFAULT_RADIUS, 1, MAX_RADIUS);
    const label = item === null ? 'items' : item.replace(/_/g, ' ');

    const skipped = new Set<string>();
    let picked = 0;
    let attempts = 0;
    let failures = 0;
    let sawCandidate = false;

    try {
      while (!ctx.signal.aborted && attempts < MAX_ATTEMPTS) {
        if (wanted !== null && picked >= wanted) break;

        const candidate = this.nearestCandidate(radius, item, skipped);
        if (candidate === null) break;

        sawCandidate = true;
        attempts += 1;
        const before = this.itemCount(item);

        const outcome = await navigateToPosition(this.facade, ctx, candidate.position, {
          description: `Walking to dropped ${candidate.name.replace(/_/g, ' ')}`,
          arriveDistance: ARRIVE_DISTANCE,
        });

        if (outcome.status === 'cancelled') {
          return cancelledResult(`Stopped collecting ${label}.`, picked, wanted ?? undefined);
        }

        const gained = Math.max(0, this.itemCount(item) - before);
        picked += gained;

        if (gained === 0) {
          // A full inventory is not a navigation problem: nothing came in
          // because there was nowhere to put it.
          if (this.facade.freeSlots() === 0) {
            return failedResult(
              `My inventory is full - I cannot pick up any more ${label}.`,
              picked,
              wanted ?? undefined,
            );
          }
          // Either unreachable or the server has not handed the stack over yet;
          // remember the spot so we move on rather than retrying it blindly.
          skipped.add(posKey(candidate.position));
          failures += 1;
          if (failures >= MAX_FAILURES) {
            return failedResult(
              `I could not reach the dropped ${label} (last one was ${candidate.distance.toFixed(1)}m away).`,
              picked,
              wanted ?? undefined,
            );
          }
        } else {
          failures = 0;
        }

        reportProgress(ctx, picked, wanted, `collected ${picked} ${label}`);
      }

      if (ctx.signal.aborted) {
        return cancelledResult(`Stopped collecting ${label}.`, picked, wanted ?? undefined);
      }

      if (wanted !== null && picked < wanted) {
        return {
          ok: false,
          detail: sawCandidate
            ? `I only collected ${picked} of ${wanted} ${label}.`
            : `I could not find ${wanted} ${label} on the ground.`,
          count: picked,
          remaining: wanted - picked,
        };
      }

      if (picked === 0) {
        // Nothing was collected, so this is a failure either way: `ok:
        // sawCandidate` would report success for a bot still standing next to
        // the stack it failed to pick up.
        if (this.facade.freeSlots() === 0) {
          return failedResult(`My inventory is full - I cannot pick up any more ${label}.`);
        }
        return failedResult(
          sawCandidate
            ? `I found dropped ${label} but could not pick it up.`
            : `I could not find any dropped ${label} nearby.`,
        );
      }

      return { ok: true, detail: `Picked up ${picked} ${label}.`, count: picked };
    } catch (error) {
      if (isCancellation(error)) {
        return cancelledResult(`Stopped collecting ${label}.`, picked, wanted ?? undefined);
      }
      return failedResult(
        `Collecting ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
        picked,
        wanted ?? undefined,
      );
    }
  }

  /** How many of `item` the bot holds, or how many items in total when null. */
  private itemCount(item: string | null): number {
    if (item !== null) return this.facade.countItem(item);
    return this.facade.getInventory().reduce((total, entry) => total + entry.count, 0);
  }

  /**
   * Nearest dropped stack we have not already failed on. When an item filter is
   * active, an entity whose item is still unknown to the server is eligible -
   * refusing it would make the bot ignore a stack it can plainly see.
   */
  private nearestCandidate(
    radius: number,
    item: string | null,
    skipped: ReadonlySet<string>,
  ): { name: string; position: { x: number; y: number; z: number }; distance: number } | null {
    for (const dropped of this.facade.getNearbyDroppedItems(radius)) {
      if (skipped.has(posKey(dropped.position))) continue;
      if (item !== null && dropped.name !== item && dropped.name !== 'unknown') continue;
      return dropped;
    }
    return null;
  }
}

export function createPickupItemsSkill(facade: MinecraftFacade): PickupItemsSkill {
  return new PickupItemsSkill(facade);
}
