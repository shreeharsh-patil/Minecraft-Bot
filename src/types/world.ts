/** World/value types shared across modules (kept free of mineflayer imports
 *  so pure logic can be unit-tested without a live bot). */

/**
 * A point in the world.
 *
 * The coordinates are readonly on purpose: a position travels together with
 * the distance that was measured to it, and a block position doubles as the
 * key a block is filed under. Mutating one in place would leave the two
 * disagreeing - the bot would believe a mob is next door while its position
 * says otherwise.
 */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A block position. Alias so signatures read clearly at call sites. */
export type BlockPos = Vec3Like;

export interface EntitySummary {
  name: string;
  type: 'hostile' | 'passive' | 'neutral' | 'player' | 'other';
  distance: number;
  position: Vec3Like;
  health?: number;
  /**
   * The server-side entity id. Attacking needs it: without it the bot can
   * only swing at the air, because the damage is delivered by an entity
   * attack packet, not by using the item.
   */
  id?: number;
}

export interface PlayerSummary {
  name: string;
  distance: number;
  position: Vec3Like;
  authorized: boolean;
  health?: number;
}

export interface ItemSummary {
  name: string;
  count: number;
  slot: number;
}

export interface InventorySummary {
  items: ItemSummary[];
  usedSlots: number;
  freeSlots: number;
  /** Item currently in the bot's main hand, if any. */
  heldItem: string | null;
}

export type TimeOfDay = 'day' | 'night' | 'dawn' | 'dusk' | 'unknown';

/**
 * Compact world snapshot handed to the LLM. Deliberately small and
 * JSON-serialisable - never the raw world.
 */
export interface WorldContext {
  position: Vec3Like;
  dimension: string;
  timeOfDay: TimeOfDay;
  health: { current: number; max: number };
  hunger: { current: number; saturation?: number };
  onGround: boolean;
  nearbyPlayers: PlayerSummary[];
  nearbyHostiles: EntitySummary[];
  nearbyBlocks: Array<{ name: string; distance: number; position: Vec3Like }>;
  nearbyChests: Array<{ distance: number; position: Vec3Like }>;
  inventory: InventorySummary;
}

/** True when every coordinate is a real number (not NaN, not Infinity). */
function isFiniteVec3(p: Vec3Like): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

/**
 * Distance between two points, in blocks.
 *
 * Never returns NaN. A non-finite coordinate means the position is unknown,
 * and an unknown distance is reported as "infinitely far away": every radius
 * filter and every "is it close?" comparison then rejects the point. A NaN
 * distance does the opposite - `NaN > maxDistance` is false, so the point
 * slipped through every radius filter and was reported as if it were next
 * door, with a NaN distance in the snapshot the model reads.
 */
export function distance3(a: Vec3Like, b: Vec3Like): number {
  if (!isFiniteVec3(a) || !isFiniteVec3(b)) return Number.POSITIVE_INFINITY;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Decimal places beyond this are meaningless: `10 ** 400` overflows to
 * Infinity and `10 ** -400` underflows to zero, and dividing by either turns
 * every coordinate into NaN.
 */
const MAX_DECIMALS = 15;

/**
 * Rounds a position to `decimals` decimal places.
 *
 * The number of decimals is clamped to a range where the scale factor stays
 * a finite, non-zero number, so the result is always a number.
 *
 * A coordinate that is not finite is left alone: the position is unknown, and
 * inventing a number for it (0 would be the world origin) would send the bot
 * somewhere it never was.
 */
export function roundPos(p: Vec3Like, decimals = 1): Vec3Like {
  const places = Number.isFinite(decimals)
    ? Math.min(MAX_DECIMALS, Math.max(-MAX_DECIMALS, Math.trunc(decimals)))
    : 1;
  const f = 10 ** places;
  return {
    x: Math.round(p.x * f) / f,
    y: Math.round(p.y * f) / f,
    z: Math.round(p.z * f) / f,
  };
}