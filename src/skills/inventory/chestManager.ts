/**
 * Chest deposit / withdraw.
 *
 * Both directions share the same plumbing here: locate a chest, walk over to it,
 * transfer the items, report exactly how many moved. Ordinary failure modes -
 * no chest nearby, full inventory, nothing to move - are reported as results,
 * never thrown.
 *
 * Note on `location`: the facade exposes no named-location lookup, so a named
 * location ("home") cannot be resolved. Rather than quietly using a different
 * chest - possibly one that belongs to a player - the skill says so and stops.
 */
import { MOVEMENT } from '../../config/constants.js';
import type { ChestRef, InventoryEntry, MinecraftFacade } from '../../types/facade.js';
import type { ChestParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import { AntiGriefRules } from '../../safety/antiGrief.js';
import type { AntiGriefContext } from '../../safety/antiGrief.js';
import type { BlockPos } from '../../types/world.js';
import { createLogger } from '../../utils/logger.js';
import { distance3 } from '../../types/world.js';
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
/**
 * A chest this close to a player is treated as that player's own chest.
 *
 * The world tracker does not record which chest belongs to whom, so proximity
 * is the closest honest signal: a chest somebody is standing next to is
 * theirs.
 */
export const PLAYER_CHEST_RADIUS = 4;
/** A full inventory stack holds this many items. */
export const MAX_STACK_SIZE = 64;
/** Location names that mean "the chest nearest to me". */
const NEAREST_LOCATION = 'nearest';

export interface TransferResult {
  ok: boolean;
  detail: string;
  count: number;
  /** Remaining amount when the transfer stopped early. */
  remaining?: number;
}

/**
 * Turns a transfer result into a skill result.
 *
 * The remainder is carried over unchanged: `failedResult` derives it from a
 * total, but the transfer helpers already know exactly how much is left.
 */
function toSkillResult(result: TransferResult): SkillResult {
  return {
    ok: result.ok,
    detail: result.detail,
    count: result.count,
    ...(result.remaining !== undefined ? { remaining: result.remaining } : {}),
  };
}

type LocateOutcome =
  | { chest: ChestRef }
  | { error: string }
  | { cancelled: true };

/**
 * Builds the anti-grief context for a chest.
 *
 * Only the player-owned containers can be worked out from what the facade
 * exposes: a chest a player is standing next to is theirs.
 */
export function chestAntiGriefContext(
  facade: MinecraftFacade,
  chest: BlockPos,
): AntiGriefContext {
  const owners = new Set<string>();
  const key = `${Math.floor(chest.x)},${Math.floor(chest.y)},${Math.floor(chest.z)}`;
  for (const player of facade.getNearbyPlayers(CHEST_SEARCH_DISTANCE + PLAYER_CHEST_RADIUS)) {
    if (distance3(player.position, chest) <= PLAYER_CHEST_RADIUS) owners.add(key);
  }
  return { playerContainers: owners };
}

/**
 * Finds the nearest usable chest, or explains why none is available.
 *
 * A named location that is not "nearest" cannot be resolved - the bot does
 * not know where "home" is - so the transfer is refused instead of landing in
 * an arbitrary (possibly player-owned) chest.
 */
function locateChest(
  facade: MinecraftFacade,
  location: string | undefined,
): LocateOutcome {
  const named = typeof location === 'string' ? location.trim().toLowerCase() : '';
  if (named.length > 0 && named !== NEAREST_LOCATION) {
    return { error: `I don't know where "${location ?? ''}" is.` };
  }

  const chest = facade.findNearestChest(CHEST_SEARCH_DISTANCE);
  if (!chest) {
    return { error: `I couldn't find a chest within ${CHEST_SEARCH_DISTANCE} blocks.` };
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
  request: { item: string; count: number; location?: string; rules?: AntiGriefRules },
): Promise<TransferResult> {
  const item = normaliseBlockName(request.item);
  if (item.length === 0) return { ok: false, detail: 'I need to know what to store.', count: 0 };

  const available = facade.countItem(item);
  if (available <= 0) {
    return { ok: false, detail: `I don't have any ${item.replace(/_/g, ' ')} to store.`, count: 0 };
  }
  // Whole items only, and at least one: a fractional or empty count would
  // reach the facade as a nonsense transfer.
  const requested = Math.floor(request.count);
  if (!Number.isFinite(requested) || requested <= 0) {
    return { ok: false, detail: 'I need a count of at least 1 to store.', count: 0 };
  }
  const count = Math.min(requested, available);

  const found = locateChest(facade, request.location);
  if ('error' in found) return { ok: false, detail: found.error, count: 0 };
  if ('cancelled' in found) return { ok: false, detail: 'Cancelled before storing.', count: 0 };

  // Anti-grief: never fill a chest that belongs to a player.
  const rules = request.rules ?? new AntiGriefRules();
  const grief = rules.canOpenChest(
    found.chest.position,
    chestAntiGriefContext(facade, found.chest.position),
    'write',
  );
  if (!grief.allowed) {
    return { ok: false, detail: grief.reason ?? 'That chest belongs to a player.', count: 0 };
  }

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
    ...(moved.value < count ? { remaining: count - moved.value } : {}),
  };
}
/** Moves `count` of `item` out of the nearest chest into the bot's inventory. */
export async function transferOutOfChest(
  facade: MinecraftFacade,
  ctx: ExecutionContext,
  request: { item?: string; count?: number; location?: string; rules?: AntiGriefRules },
): Promise<TransferResult> {
  const found = locateChest(facade, request.location);
  if ('error' in found) return { ok: false, detail: found.error, count: 0 };
  if ('cancelled' in found) return { ok: false, detail: 'Cancelled before taking items.', count: 0 };

  // Anti-grief: a player-owned chest may be read, never written.
  const rules = request.rules ?? new AntiGriefRules();
  const grief = rules.canOpenChest(
    found.chest.position,
    chestAntiGriefContext(facade, found.chest.position),
    'read',
  );
  if (!grief.allowed) {
    return { ok: false, detail: grief.reason ?? 'I cannot open that chest.', count: 0 };
  }

  // Everything below is checked BEFORE the bot walks: a request that cannot
  // be honoured must not send it to a chest it is not going to use.
  const wanted = request.item !== undefined ? normaliseBlockName(request.item) : null;
  if (wanted !== null && wanted.length === 0) {
    return { ok: false, detail: 'I need to know what to take out.', count: 0 };
  }

  // A full inventory is an ordinary condition, not an error to throw.
  const free = facade.freeSlots();
  if (free !== null && free <= 0) {
    return { ok: false, detail: "My inventory is full - I can't take anything out.", count: 0 };
  }

  // The free slots are a STACK budget, not an item count: one free slot
  // holds a whole stack.
  const stackBudget = free !== null ? free * MAX_STACK_SIZE : MAX_STACK_SIZE;
  const requested = Math.floor(request.count ?? stackBudget);
  if (!Number.isFinite(requested) || requested <= 0) {
    return { ok: false, detail: 'I need a count of at least 1.', count: 0 };
  }
  // Never ask for more than the inventory can hold. Mineflayer moves items
  // until the destination is full and then throws "destination full", and the
  // facade reports that as "nothing moved" - so an oversized request would
  // lose the count of what did move and report a full chest as empty.
  const count = free !== null ? Math.min(requested, stackBudget) : requested;

  const reached = await reachChest(facade, ctx, found.chest);
  if ('error' in reached) return { ok: false, detail: reached.error, count: 0 };
  if ('cancelled' in reached) return { ok: false, detail: 'Cancelled before taking items.', count: 0 };

  if (wanted === null) {
    // No item named: grab a useful stack rather than guessing at one item.
    const grab = await takeSomething(facade, ctx, found.chest, count);
    // Only an explicit request has a meaningful "still missing" number.
    if (grab.ok && request.count !== undefined && grab.count < requested) {
      return { ...grab, remaining: requested - grab.count };
    }
    return grab;
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
  const label = wanted.replace(/_/g, ' ');
  return {
    ok: true,
    detail: taken.value < count ? `Took ${taken.value} of ${count} ${label}.` : `Took ${taken.value} ${label}.`,
    count: taken.value,
    ...(taken.value < count ? { remaining: count - taken.value } : {}),
  };
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
    const wants = heldNames.has(candidate) ? Math.min(MAX_STACK_SIZE, budget - total) : budget - total;
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

  constructor(
    private readonly facade: MinecraftFacade,
    private readonly rules: AntiGriefRules = new AntiGriefRules(),
  ) {}

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

      const result = await transferIntoChest(this.facade, ctx, {
        item: requested,
        count,
        ...(params.location !== undefined ? { location: params.location } : {}),
        rules: this.rules,
      });
      return toSkillResult(result);
    } catch (error) {
      if (isCancellation(error)) return { ok: false, detail: 'Stopped while storing items.', count: 0 };
      return failedResult(`Storing items failed: ${describeError(error)}`, 0);
    }
  }
}

export class WithdrawItemsSkill implements Skill<ChestParams> {
  public readonly name: ActionType = 'withdraw_items';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.INVENTORY];

  constructor(
    private readonly facade: MinecraftFacade,
    private readonly rules: AntiGriefRules = new AntiGriefRules(),
  ) {}

  public async execute(params: ChestParams, ctx: ExecutionContext): Promise<SkillResult> {
    try {
      const result = await transferOutOfChest(this.facade, ctx, {
        ...(params.item !== undefined ? { item: params.item } : {}),
        ...(params.count !== undefined ? { count: params.count } : {}),
        ...(params.location !== undefined ? { location: params.location } : {}),
        rules: this.rules,
      });
      return toSkillResult(result);
    } catch (error) {
      if (isCancellation(error)) return { ok: false, detail: 'Stopped while taking items.', count: 0 };
      return failedResult(`Taking items failed: ${describeError(error)}`, 0);
    }
  }
}

export function createDepositItemsSkill(
  facade: MinecraftFacade,
  rules?: AntiGriefRules,
): DepositItemsSkill {
  return new DepositItemsSkill(facade, rules);
}

export function createWithdrawItemsSkill(
  facade: MinecraftFacade,
  rules?: AntiGriefRules,
): WithdrawItemsSkill {
  return new WithdrawItemsSkill(facade, rules);
}
