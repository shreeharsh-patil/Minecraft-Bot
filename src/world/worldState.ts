/**
 * Compact world state snapshot.
 *
 * Caches expensive scans (nearby blocks) for a short TTL so a burst of chat or
 * AI requests does not repeatedly hammer `findBlocks`, which is the most
 * expensive operation in the bot.
 */
import type {
  WorldContext,
  TimeOfDay,
  Vec3Like,
  PlayerSummary,
  EntitySummary,
  ItemSummary,
} from '../types/world.js';
import { roundPos, distance3 } from '../types/world.js';
import type { MinecraftFacade } from '../types/facade.js';
import { MOVEMENT } from '../config/constants.js';
import type { Logger } from '../utils/logger.js';

/** Cache lifetime for expensive world scans. */
const SCAN_TTL_MS = 1_000;

/**
 * "Never scanned" marker for the scan caches.
 *
 * A plain `0` cannot be used for this: `now` is supplied by the caller, so a
 * clock that starts near zero (or an `invalidate()` followed by a build
 * inside the first TTL) would look like a fresh scan and the empty cache
 * would be served as if it were real data.
 */
const NEVER_SCANNED = Number.NEGATIVE_INFINITY;

export interface WorldStateOptions {
  scanRadius?: number;
  scanTtlMs?: number;
  /** Names considered "important" when reporting nearby blocks. */
  interestingBlocks?: readonly string[];
}

/** Blocks worth telling the model about. */
export const DEFAULT_INTERESTING_BLOCKS: readonly string[] = [
  'chest',
  'barrel',
  'crafting_table',
  'furnace',
  'anvil',
  'enchanting_table',
  'bed',
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'stone',
  'cobblestone',
  'diamond_ore',
  'iron_ore',
  'gold_ore',
  'coal_ore',
  'lava',
  'water',
];

export class WorldState {
  private readonly facade: MinecraftFacade;
  private readonly logger: Logger;
  private readonly scanRadius: number;
  private readonly scanTtlMs: number;
  private readonly interesting: ReadonlySet<string>;

  private cachedScanAt = NEVER_SCANNED;
  private cachedBlocks: Array<{ name: string; distance: number; position: Vec3Like }> = [];
  private cachedChestAt = NEVER_SCANNED;
  private cachedChests: Array<{ distance: number; position: Vec3Like }> = [];

  constructor(facade: MinecraftFacade, logger: Logger, options: WorldStateOptions = {}) {
    this.facade = facade;
    this.logger = logger.child({ component: 'world-state' });
    this.scanRadius = options.scanRadius ?? MOVEMENT.SCAN_RADIUS;
    this.scanTtlMs = options.scanTtlMs ?? SCAN_TTL_MS;
    this.interesting = new Set(options.interestingBlocks ?? DEFAULT_INTERESTING_BLOCKS);
  }

  /** Invalidates the scan cache (call after the bot moves significantly). */
  invalidate(): void {
    this.cachedScanAt = NEVER_SCANNED;
    this.cachedChestAt = NEVER_SCANNED;
  }

  /**
   * Is a scan still fresh at `now`?
   *
   * The age must not be negative. When the clock moves backwards (an NTP
   * correction, or a caller passing an earlier `now` than the previous call)
   * the age goes negative, which satisfies the TTL test forever and freezes
   * the snapshot until the clock catches up again.
   */
  private isFresh(scannedAt: number, now: number): boolean {
    const age = now - scannedAt;
    return age >= 0 && age < this.scanTtlMs;
  }

  private nearbyBlocks(now: number): Array<{ name: string; distance: number; position: Vec3Like }> {
    if (this.isFresh(this.cachedScanAt, now)) return this.cachedBlocks;
    try {
      this.cachedBlocks = this.facade
        .scanNearbyBlocks(this.scanRadius)
        .filter((b) => this.interesting.has(b.name))
        .map((b) => ({
          name: b.name,
          distance: Math.round(b.distance * 10) / 10,
          position: roundPos(b.position),
        }))
        .slice(0, 40);
      this.cachedScanAt = now;
    } catch (error) {
      // A failed scan must not break context building.
      this.logger.warn('nearby block scan failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.cachedBlocks = [];
      this.cachedScanAt = now;
    }
    return this.cachedBlocks;
  }

  private nearbyChests(now: number): Array<{ distance: number; position: Vec3Like }> {
    // Cached like the block scan: the chest lookup walks the world and was
    // repeated on every single context build.
    if (this.isFresh(this.cachedChestAt, now)) return this.cachedChests;
    try {
      const chest = this.facade.findNearestChest(16);
      this.cachedChests = chest
        ? [{ distance: Math.round(chest.distance * 10) / 10, position: roundPos(chest.position) }]
        : [];
    } catch (error) {
      // A failed scan must not break context building: the real chest lookup
      // walks the world and throws when the bot is not spawned yet.
      this.logger.warn('nearest chest lookup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.cachedChests = [];
    }
    this.cachedChestAt = now;
    return this.cachedChests;
  }

  /** Builds the compact snapshot handed to the LLM. */
  buildContext(now: number = Date.now()): WorldContext {
    const position = this.facade.getPosition();
    const health = this.facade.getHealth();
    const hunger = this.facade.getHunger();

    const players: PlayerSummary[] = this.facade
      .getNearbyPlayers(48)
      .slice(0, 8)
      .map((p) => ({
        name: p.name,
        distance: Math.round(p.distance * 10) / 10,
        position: roundPos(p.position),
        authorized: p.authorized,
      }));

    const hostiles: EntitySummary[] = this.facade
      .getNearbyEntities(24)
      .filter((e) => e.type === 'hostile')
      .slice(0, 8)
      .map((e) => ({
        name: e.name,
        type: e.type,
        distance: Math.round(e.distance * 10) / 10,
        position: roundPos(e.position),
        // The entity id is carried through: attacking needs it, because the
        // damage is delivered by an entity attack packet. Without it the
        // planner can only swing at the air.
        ...(e.id !== undefined ? { id: e.id } : {}),
        ...(e.health !== undefined ? { health: e.health } : {}),
      }));

    const inventory: ItemSummary[] = this.facade
      .getInventory()
      .slice(0, 36)
      .map((i) => ({ name: i.item, count: i.count, slot: i.slot }));

    const usedSlots = inventory.length;
    const freeSlots = this.facade.freeSlots();

    return {
      position: roundPos(position),
      dimension: this.facade.dimension,
      timeOfDay: this.timeOfDay(),
      health: { current: Math.round(health.current), max: health.max },
      hunger: { current: Math.round(hunger.current), saturation: Math.round(hunger.saturation) },
      onGround: this.facade.isOnGround(),
      nearbyPlayers: players,
      nearbyHostiles: hostiles,
      nearbyBlocks: this.nearbyBlocks(now),
      nearbyChests: this.nearbyChests(now),
      inventory: {
        items: inventory,
        usedSlots,
        freeSlots: freeSlots ?? Math.max(0, 36 - usedSlots),
        heldItem: this.facade.heldItem(),
      },
    };
  }

  private timeOfDay(): TimeOfDay {
    return this.facade.getTimeOfDay();
  }

  /** Distance to the named player, or null. */
  distanceToPlayer(name: string): number | null {
    const player = this.facade.getNearestPlayer(name);
    if (!player) return null;
    return distance3(this.facade.getPosition(), player.position);
  }
}