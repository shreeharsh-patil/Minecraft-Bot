/** World/value types shared across modules (kept free of mineflayer imports
 *  so pure logic can be unit-tested without a live bot). */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
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

export function distance3(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function roundPos(p: Vec3Like, decimals = 1): Vec3Like {
  const f = 10 ** decimals;
  return {
    x: Math.round(p.x * f) / f,
    y: Math.round(p.y * f) / f,
    z: Math.round(p.z * f) / f,
  };
}