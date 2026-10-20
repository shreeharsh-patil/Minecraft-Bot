/**
 * `pickup_items`: collect dropped items (a player's discarded stack, a death
 * pile, items spilled by a chest) from the ground.
 *
 * Minecraft's own pickup mechanic does the collecting - the bot only has to
 * walk onto the items. This skill therefore:
 *  - scans for dropped item entities in a bounded radius;
 *  - walks to the nearest candidate and skips piles that turned out to be
 *    unreachable instead of hammering the same hole forever;
 *  - waits for the server to hand a stack over before it counts it, because
 *    Minecraft applies a pickup on its next tick and not when the walk ends;
 *  - stops as soon as the requested count is satisfied, or nothing is left;
 *  - reports the *inventory delta*, not the number of piles visited, so the
 *    number the player sees in chat is truthful.
 */
import type { MinecraftFacade } from '../../types/facade.js';
import type { Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import { waitUntil } from '../../utils/sleep.js';
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
/**
 * How long the server may take to hand a stack over once we stand on it.
 *
 * Minecraft applies a pickup on its next tick, so the item is not in the
 * inventory yet when the walk resolves. The Rust runtime waits for the drop
 * to leave the world; this is the same grace window for the TS runtime.
 */
const PICKUP_GRACE_MS = 2_000;
/** How often the inventory is re-read while waiting for a hand-over. */
const PICKUP_POLL_MS = 50;

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
    if (item !== null && item.length === 0) {
      // A name that normalises to nothing ("!!!") is not an item name. It
      // must never fall back to "collect everything".
      return failedResult('I need a valid item name to collect.', 0);
    }
    if (typeof params.count === 'number' && Number.isFinite(params.count) && params.count < 1) {
      // Clamping a count of 0 to 1 would collect an item the caller did not
      // ask for.
      return failedResult('I need a count of at least 1.', 0);
    }
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

        let gained = Math.max(0, this.itemCount(item) - before);
        if (gained === 0 && outcome.status === 'arrived' && this.facade.freeSlots() !== 0) {
          // We are standing on the stack, but the server applies the pickup
          // on its next tick - so the item is not in the inventory yet. Give
          // it a moment, otherwise a stack that IS collected looks like a
          // failure and is never counted.
          gained = await this.awaitHandOver(ctx, item, before);
        }
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
            const where = ` (last one was ${candidate.distance.toFixed(1)}m away)`;
            return failedResult(
              outcome.status === 'arrived'
                ? `I reached the dropped ${label} but it never came into my inventory${where}.`
                : `I could not reach the dropped ${label}${where}.`,
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

      // The attempt ceiling can end the run while stacks are still lying on
      // the ground. Say so instead of pretending everything was collected.
      const truncated =
        wanted === null &&
        attempts >= MAX_ATTEMPTS &&
        this.nearestCandidate(radius, item, skipped) !== null;

      return {
        ok: true,
        detail: truncated
          ? `Picked up ${picked} ${label}, but some are still on the ground.`
          : `Picked up ${picked} ${label}.`,
        count: picked,
      };
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
   * Wait for the server to hand over the stack the bot is standing on.
   *
   * Minecraft applies a pickup on its next tick, so the stack is not in the
   * inventory yet when the walk resolves. Returns how much actually arrived;
   * zero means the stack never came. A cancellation is passed on to the
   * caller instead of being reported as a failed pickup.
   */
  private async awaitHandOver(
    ctx: ExecutionContext,
    item: string | null,
    before: number,
  ): Promise<number> {
    try {
      await waitUntil(() => this.itemCount(item) > before, {
        timeoutMs: PICKUP_GRACE_MS,
        intervalMs: PICKUP_POLL_MS,
        signal: ctx.signal,
        description: 'the server did not hand the stack over',
      });
    } catch (error) {
      if (isCancellation(error)) throw error;
      // The grace window expired: the pile really yielded nothing.
    }
    return Math.max(0, this.itemCount(item) - before);
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
