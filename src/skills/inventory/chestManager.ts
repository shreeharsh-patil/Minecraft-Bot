/**
 * Chest deposit / withdraw.
 *
 * Both directions share the same plumbing here: locate a chest, walk over to it,
 * transfer the items, report exactly how many moved. Ordinary failure modes -
 * no chest nearby, full inventory, nothing to move - are reported as results,
 * never thrown.
 *
 * Note on `location`: the facade exposes no named-location lookup, so a named
 * location ("home") falls back to the nearest chest and says so in chat.
 */
import { MOVEMENT } from '../../config/constants.js';
import type { ChestRef, InventoryEntry, MinecraftFacade } from '../../types/facade.js';
import type { ChestParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import { createLogger } from '../../utils/logger.js';
import {
  approachBlock,
  describeError,
  failedResult,
  guardedOp,
  isCancellation,
  normaliseBlockName,
} from '../internal/helpers.js';

const log = createLogger({ level: 'info' }).child({ layer: 'skills', skill: 'chest' });

/** How far away we are willing to walk for a chest. */
export const CHEST_SEARCH_DISTANCE = MOVEMENT.SCAN_RADIUS * 4;

export interface TransferResult {
  ok: boolean;
  detail: string;
  count: number;
  /** Remaining amount when the transfer stopped early. */
  remaining?: number;
}

type LocateOutcome =
  | { chest: ChestRef }
  | { error: string }
  | { cancelled: true };

/** Finds the nearest usable chest, or explains why none is available. */
function locateChest(
  facade: MinecraftFacade,
  ctx: ExecutionContext,
  location: string | undefined,
): LocateOutcome {
  const chest = facade.findNearestChest(CHEST_SEARCH_DISTANCE);
  if (!chest) {
    return { error: `I couldn't find a chest within ${CHEST_SEARCH_DISTANCE} blocks.` };
  }
  const named = typeof location === 'string' ? location.trim().toLowerCase() : '';
  if (named.length > 0 && named !== 'nearest') {
    // No named-location lookup exists in the facade; be honest about it.
    ctx.say(`I can't look up "${location ?? ''}" yet - using the nearest chest.`);
  }
  return { chest };
}

/** Walks to a chest so transfers are actually in range. */
async function reachChest(
  facade: MinecraftFacade,
  ctx: ExecutionContext,
  chest: ChestRef,
): Promise<{ ok: true } | { error: string } | { cancelled: true }> {
  const arrival = await approachBlock(facade, ctx, chest.position, 'Walking to the chest');
  if (arrival.status === 'cancelled') return { cancelled: true };
  if (arrival.status !== 'arrived') {
    return { error: `I couldn't reach the chest: ${arrival.reason}` };
  }
  return { ok: true };
}

/**
 * Moves `count` of `item` from the bot's inventory into the nearest chest.
 * Used by both the deposit skill and `dropItem` with `where: 'chest'`.
 */
export async function transferIntoChest(
  facade: MinecraftFacade,
  ctx: ExecutionContext,
  request: { item: string; count: number },
): Promise<TransferResult> {
  const item = normaliseBlockName(request.item);
  if (item.length === 0) return { ok: false, detail: 'I need to know what to store.', count: 0 };

  const available = facade.countItem(item);
  if (available <= 0) {
    return { ok: false, detail: `I don't have any ${item.replace(/_/g, ' ')} to store.`, count: 0 };
  }
  const count = Math.min(request.count, available);

  const found = locateChest(facade, ctx, undefined);
  if ('error' in found) return { ok: false, detail: found.error, count: 0 };
  if ('cancelled' in found) return { ok: false, detail: 'Cancelled before storing.', count: 0 };

  const reached = await reachChest(facade, ctx, found.chest);
  if ('error' in reached) return { ok: false, detail: reached.error, count: 0 };
  if ('cancelled' in reached) return { ok: false, detail: 'Cancelled before storing.', count: 0 };

  const moved = await guardedOp(
    () => facade.depositIntoChest(found.chest.position, item, count),
    ctx,
    `Storing ${item}`,
  );
  if (moved.status === 'cancelled') return { ok: false, detail: 'Cancelled while storing.', count: 0 };
  if (moved.status === 'error') return { ok: false, detail: moved.reason, count: 0 };
  if (moved.value <= 0) {
    return {
      ok: false,
      detail: `The chest wouldn't take any ${item.replace(/_/g, ' ')}. It may be full.`,
      count: 0,
      remaining: count,
    };
  }
  return {
    ok: true,
    detail:
      moved.value < count
        ? `Stored ${moved.value} of ${count} ${item.replace(/_/g, ' ')}.`
        : `Stored ${moved.value} ${item.replace(/_/g, ' ')}.`,
    count: moved.value,
  };
}
/** Moves `count` of `item` out of the nearest chest into the bot's inventory. */
export async function transferOutOfChest(
  facade: MinecraftFacade,
  ctx: ExecutionContext,
  request: { item?: string; count?: number; location?: string },
): Promise<TransferResult> {
  const found = locateChest(facade, ctx, request.location);
  if ('error' in found) return { ok: false, detail: found.error, count: 0 };
  if ('cancelled' in found) return { ok: false, detail: 'Cancelled before taking items.', count: 0 };

  const reached = await reachChest(facade, ctx, found.chest);
  if ('error' in reached) return { ok: false, detail: reached.error, count: 0 };
  if ('cancelled' in reached) return { ok: false, detail: 'Cancelled before taking items.', count: 0 };

  // A full inventory is an ordinary condition, not an error to throw.
  const free = facade.freeSlots();
  if (free !== null && free <= 0) {
    return { ok: false, detail: "My inventory is full - I can't take anything out.", count: 0 };
  }

  const wanted = request.item !== undefined ? normaliseBlockName(request.item) : null;
  if (wanted !== null && wanted.length === 0) {
    return { ok: false, detail: 'I need to know what to take out.', count: 0 };
  }

  const count = Math.floor(request.count ?? (free !== null ? free : 1));
  if (!Number.isFinite(count) || count <= 0) {
    return { ok: false, detail: 'I need a count of at least 1.', count: 0 };
  }

  if (wanted === null) {
    // No item named: grab a useful stack rather than guessing at one item.
    return takeSomething(facade, ctx, found.chest, count);
  }

  const taken = await guardedOp(
    () => facade.withdrawFromChest(found.chest.position, wanted, count),
    ctx,
    `Taking ${wanted}`,
  );
  if (taken.status === 'cancelled') {
    return { ok: false, detail: 'Cancelled while taking items.', count: 0 };
  }
  if (taken.status === 'error') {
    return { ok: false, detail: taken.reason, count: 0 };
  }
  if (taken.value <= 0) {
    return { ok: false, detail: `There is no ${wanted.replace(/_/g, ' ')} in that chest.`, count: 0 };
  }
  return { ok: true, detail: `Took ${taken.value} ${wanted.replace(/_/g, ' ')}.`, count: taken.value };
}

/**
 * Withdraws a useful stack when no item was named. The facade has no
 * "list chest contents" call, so this probes a small explicit candidate list.
 */
async function takeSomething(
  facade: MinecraftFacade,
  ctx: ExecutionContext,
  chest: ChestRef,
  budget: number,
): Promise<TransferResult> {
  const held: readonly InventoryEntry[] = facade.getInventory();
  const heldNames = new Set(held.map((entry) => entry.item));
  const candidates = ['cobblestone', 'dirt', 'sand', 'stone', 'oak_log', 'bread', 'torch'];

  let total = 0;
  const taken: string[] = [];

  for (const candidate of candidates) {
    if (ctx.signal.aborted) break;
    if (total >= budget) break;
    // Ask for more of something already carried so stacks merge.
    const wants = heldNames.has(candidate) ? Math.min(64, budget - total) : budget - total;
    const result = await guardedOp(
      () => facade.withdrawFromChest(chest.position, candidate, wants),
      ctx,
      `Taking ${candidate}`,
    );
    if (result.status !== 'ok' || result.value <= 0) continue;
    total += result.value;
    taken.push(`${result.value} ${candidate}`);
  }

  if (total <= 0) {
    log.debug('withdraw found nothing', { at: chest.position });
    return { ok: false, detail: "I couldn't find anything useful in that chest.", count: 0 };
  }
  return { ok: true, detail: `Took ${taken.join(', ')}.`, count: total };
}

export class DepositItemsSkill implements Skill<ChestParams> {
  public readonly name: ActionType = 'deposit_items';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.INVENTORY];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: ChestParams, ctx: ExecutionContext): Promise<SkillResult> {
    try {
      const requested = normaliseBlockName(params.item ?? '');
      if (requested.length === 0) {
        return failedResult('I need to know what to store.', 0);
      }
      const available = this.facade.countItem(requested);
      if (available <= 0) {
        return failedResult(`I don't have any ${requested.replace(/_/g, ' ')} to store.`, 0);
      }
      const count = Math.floor(params.count ?? available);
      if (!Number.isFinite(count) || count <= 0) {
        return failedResult('I need a count of at least 1 to store.', 0);
      }

      const result = await transferIntoChest(this.facade, ctx, { item: requested, count });
      if (!result.ok) return failedResult(result.detail, result.count);
      return { ok: true, detail: result.detail, count: result.count };
    } catch (error) {
      if (isCancellation(error)) return { ok: false, detail: 'Stopped while storing items.', count: 0 };
      return failedResult(`Storing items failed: ${describeError(error)}`, 0);
    }
  }
}

export class WithdrawItemsSkill implements Skill<ChestParams> {
  public readonly name: ActionType = 'withdraw_items';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.INVENTORY];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: ChestParams, ctx: ExecutionContext): Promise<SkillResult> {
    try {
      const result = await transferOutOfChest(this.facade, ctx, {
        ...(params.item !== undefined ? { item: params.item } : {}),
        ...(params.count !== undefined ? { count: params.count } : {}),
        ...(params.location !== undefined ? { location: params.location } : {}),
      });
      if (!result.ok) return failedResult(result.detail, result.count);
      return { ok: true, detail: result.detail, count: result.count };
    } catch (error) {
      if (isCancellation(error)) return { ok: false, detail: 'Stopped while taking items.', count: 0 };
      return failedResult(`Taking items failed: ${describeError(error)}`, 0);
    }
  }
}

export function createDepositItemsSkill(facade: MinecraftFacade): DepositItemsSkill {
  return new DepositItemsSkill(facade);
}

export function createWithdrawItemsSkill(facade: MinecraftFacade): WithdrawItemsSkill {
  return new WithdrawItemsSkill(facade);
}