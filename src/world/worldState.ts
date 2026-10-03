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

  private cachedScanAt = 0;
  private cachedBlocks: Array<{ name: string; distance: number; position: Vec3Like }> = [];

  constructor(facade: MinecraftFacade, logger: Logger, options: WorldStateOptions = {}) {
    this.facade = facade;
    this.logger = logger.child({ component: 'world-state' });
    this.scanRadius = options.scanRadius ?? MOVEMENT.SCAN_RADIUS;
    this.scanTtlMs = options.scanTtlMs ?? SCAN_TTL_MS;
    this.interesting = new Set(options.interestingBlocks ?? DEFAULT_INTERESTING_BLOCKS);
  }

  /** Invalidates the scan cache (call after the bot moves significantly). */
  invalidate(): void {
    this.cachedScanAt = 0;
  }

  private nearbyBlocks(now: number): Array<{ name: string; distance: number; position: Vec3Like }> {
    if (now - this.cachedScanAt < this.scanTtlMs) return this.cachedBlocks;
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
    const chest = this.facade.findNearestChest(16);
    if (!chest) return [];
    void now;
    return [{ distance: Math.round(chest.distance * 10) / 10, position: roundPos(chest.position) }];
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