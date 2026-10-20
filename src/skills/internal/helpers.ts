/**
 * Internal helpers shared by every skill.
 *
 * Rules enforced here so no individual skill has to remember them:
 *  - every facade call is cancellable (`ctx.signal`) and time-boxed;
 *  - ordinary game failures come back as typed outcomes / `SkillResult`s,
 *    never as thrown errors;
 *  - pathing never routes through instant-death blocks.
 */
import { DANGEROUS_BLOCKS, MOVEMENT } from '../../config/constants.js';
import type { MinecraftFacade, MoveResult } from '../../types/facade.js';
import type { SkillResult } from '../../types/skill.js';
import type { ExecutionContext, TaskProgress } from '../../types/task.js';
import type { BlockPos, EntitySummary, Vec3Like } from '../../types/world.js';
import { AbortedError, withTimeout } from '../../utils/sleep.js';

/** Timeout for a single facade action (dig, place, chest transfer, eat, ...). */
export const ACTION_TIMEOUT_MS = 15_000;

/** Extra time allowed on top of the facade's own pathfinding timeout. */
const NAV_GRACE_MS = 2_000;

/**
 * Blocks pathing refuses to route through. Water is excluded on purpose: it is
 * not instant death and refusing it would make the bot unable to cross rivers
 * or swim to the player it is following.
 */
export const PATHING_HAZARDS: readonly string[] = [...DANGEROUS_BLOCKS].filter(
  (block) => block !== 'water' && block !== 'flowing_water',
);

/** Outcome of a single (abortable, time-boxed) facade operation. */
export type OpOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'cancelled' }
  | { status: 'error'; reason: string };

/** Outcome of a navigation attempt. Mirrors `MoveResult` without throwing. */
export type NavOutcome =
  | { status: 'arrived'; distance: number }
  | { status: 'blocked'; reason: string }
  | { status: 'unreachable'; reason: string }
  | { status: 'cancelled' };

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

export function isCancellation(error: unknown): boolean {
  return error instanceof AbortedError || (error instanceof Error && error.name === 'AbortError');
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Stable key for a block position, used to remember blocks already tried. */
export function posKey(p: Vec3Like): string {
  return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
}

export function floorPos(p: Vec3Like): BlockPos {
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

export function formatPos(p: Vec3Like): string {
  return `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`;
}

/** "oak logs" / "Oak-Log" -> "oak_log". Keeps model output tolerant. */
export function normaliseBlockName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

export function isDangerousBlock(name: string | null | undefined): boolean {
  return typeof name === 'string' && DANGEROUS_BLOCKS.has(name);
}

/** Partial success / failure / cancellation reporting. Never throws. */
export function reportResult(
  ok: boolean,
  detail: string,
  count: number,
  total?: number,
): SkillResult {
  if (total !== undefined && total > 0) {
    return { ok, detail, count, remaining: Math.max(0, total - count) };
  }
  return { ok, detail, count };
}

export function cancelledResult(detail: string, count = 0, total?: number): SkillResult {
  return reportResult(false, detail, count, total);
}

export function failedResult(detail: string, count = 0, total?: number): SkillResult {
  return reportResult(false, detail, count, total);
}

/** Feeds `ctx.progress` with a normalised fraction. */
export function reportProgress(
  ctx: ExecutionContext,
  current: number,
  total: number | null,
  detail?: string,
): void {
  const partial: Partial<TaskProgress> = {
    current,
    total,
    fraction: total !== null && total > 0 ? clamp(current / total, 0, 1) : null,
  };
  if (detail !== undefined) partial.detail = detail;
  ctx.progress(partial);
}

/**
 * Runs one facade operation with a hard timeout and abort support.
 * Never throws: aborts and failures come back as a typed outcome.
 */
export async function guardedOp<T>(
  start: () => Promise<T>,
  ctx: ExecutionContext,
  description: string,
  timeoutMs: number = ACTION_TIMEOUT_MS,
): Promise<OpOutcome<T>> {
  if (ctx.signal.aborted) return { status: 'cancelled' };

  let work: Promise<T>;
  try {
    work = start();
  } catch (error) {
    return { status: 'error', reason: `${description} failed: ${describeError(error)}` };
  }
  // Attach a handler up front so a late rejection (after we already timed out)
  // can never surface as an unhandled rejection.
  void work.catch(() => undefined);

  try {
    const value = await withTimeout(work, timeoutMs, description, ctx.signal);
    if (ctx.signal.aborted) return { status: 'cancelled' };
    return { status: 'ok', value };
  } catch (error) {
    if (ctx.signal.aborted || isCancellation(error)) return { status: 'cancelled' };
    return { status: 'error', reason: `${description} failed: ${describeError(error)}` };
  }
}

export function toNavOutcome(result: MoveResult): NavOutcome {
  switch (result.status) {
    case 'arrived':
      return { status: 'arrived', distance: result.distance };
    case 'blocked':
      return { status: 'blocked', reason: result.reason };
    case 'unreachable':
      return { status: 'unreachable', reason: result.reason };
    case 'cancelled':
      return { status: 'cancelled' };
    default:
      return { status: 'blocked', reason: 'unknown navigation result' };
  }
}

export interface NavigateOptions {
  /** Used in messages/logs, e.g. "walking to Alice". */
  description: string;
  arriveDistance?: number;
  timeoutMs?: number;
  avoid?: readonly string[];
  maxNodes?: number;
}

/** Move to a position. Aborts promptly and reports rather than throwing. */
export async function navigateToPosition(
  facade: MinecraftFacade,
  ctx: ExecutionContext,
  target: Vec3Like,
  options: NavigateOptions,
): Promise<NavOutcome> {
  const timeoutMs = options.timeoutMs ?? MOVEMENT.PATH_TIMEOUT_MS;
  const outcome = await guardedOp(
    () =>
      facade.moveToPosition(target, {
        signal: ctx.signal,
        timeoutMs,
        arriveDistance: options.arriveDistance ?? MOVEMENT.ARRIVE_DISTANCE,
        avoid: options.avoid ?? PATHING_HAZARDS,
        ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
      }),
    ctx,
    options.description,
    timeoutMs + NAV_GRACE_MS,
  );

  if (outcome.status === 'ok') return toNavOutcome(outcome.value);
  if (outcome.status === 'cancelled') return { status: 'cancelled' };
  return { status: 'blocked', reason: outcome.reason };
}

/** Move to a player. Aborts promptly and reports rather than throwing. */
export async function navigateToPlayer(
  facade: MinecraftFacade,
  ctx: ExecutionContext,
  player: string,
  options: NavigateOptions,
): Promise<NavOutcome> {
  const timeoutMs = options.timeoutMs ?? MOVEMENT.PATH_TIMEOUT_MS;
  const outcome = await guardedOp(
    () =>
      facade.moveToPlayer(player, {
        signal: ctx.signal,
        timeoutMs,
        arriveDistance: options.arriveDistance ?? MOVEMENT.ARRIVE_DISTANCE,
        avoid: options.avoid ?? PATHING_HAZARDS,
        ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
      }),
    ctx,
    options.description,
    timeoutMs + NAV_GRACE_MS,
  );

  if (outcome.status === 'ok') return toNavOutcome(outcome.value);
  if (outcome.status === 'cancelled') return { status: 'cancelled' };
  return { status: 'blocked', reason: outcome.reason };
}

/** The six blocks touching `block` - somewhere the bot can stand to dig it. */
export function neighbours(block: BlockPos): BlockPos[] {
  return [
    { x: block.x + 1, y: block.y, z: block.z },
    { x: block.x - 1, y: block.y, z: block.z },
    { x: block.x, y: block.y + 1, z: block.z },
    { x: block.x, y: block.y - 1, z: block.z },
    { x: block.x, y: block.y, z: block.z + 1 },
    { x: block.x, y: block.y, z: block.z - 1 },
  ];
}

/**
 * Walks to a position adjacent to `block` so it can be dug or built against.
 * Tries each neighbour in turn - the bot never digs through a wall.
 */
export async function approachBlock(
  facade: MinecraftFacade,
  ctx: ExecutionContext,
  block: BlockPos,
  description: string,
): Promise<NavOutcome> {
  let last: NavOutcome = { status: 'unreachable', reason: 'no reachable side of the block' };
  for (const target of neighbours(block)) {
    if (ctx.signal.aborted) return { status: 'cancelled' };
    if (facade.isDangerous(target)) continue;
    const outcome = await navigateToPosition(facade, ctx, target, {
      description,
      arriveDistance: MOVEMENT.ARRIVE_DISTANCE,
    });
    if (outcome.status === 'arrived' || outcome.status === 'cancelled') return outcome;
    last = outcome;
  }
  return last;
}

/**
 * `EntitySummary` carries no entity id, yet `attackEntity` needs one. We read an
 * optional numeric `id` when the facade provides one, and fall back to a swing
 * (look + use) when it does not.
 */
export function resolveEntityId(entity: EntitySummary): number | null {
  const candidate = (entity as { id?: unknown }).id;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

/**
 * Is an entity standing in this block cell?
 *
 * A block placed where somebody is standing is materialised inside them, so
 * the building skills refuse that cell instead of trapping a player.
 */
export function entityOccupiesCell(
  facade: MinecraftFacade,
  cell: BlockPos,
  radius = 8,
): EntitySummary | null {
  const target = floorPos(cell);
  for (const entity of facade.getNearbyEntities(radius)) {
    // Dropped items and other clutter do not occupy a cell.
    if (entity.type === 'other') continue;
    const at = floorPos(entity.position);
    if (at.x === target.x && at.y === target.y && at.z === target.z) return entity;
  }
  return null;
}

/**
 * A chat gate for skills that repeat themselves.
 *
 * A skill that ticks every 500ms would otherwise say the same line twice a
 * second, which is exactly what a server's spam filter punishes. The gate
 * lets a message through when it CHANGES (a state change is worth saying) and
 * otherwise at most once per `minIntervalMs`.
 */
export class ChatGate {
  private lastMessage: string | null = null;
  private lastAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  /** True when the message may be sent now. Records it when it may. */
  allow(message: string, now: number = Date.now()): boolean {
    const changed = message !== this.lastMessage;
    if (!changed && now - this.lastAt < this.minIntervalMs) return false;
    this.lastMessage = message;
    this.lastAt = now;
    return true;
  }

  /** Sends the message through the context when the gate allows it. */
  speak(ctx: ExecutionContext, message: string, now: number = Date.now()): boolean {
    if (!this.allow(message, now)) return false;
    ctx.say(message);
    return true;
  }
}