/**
 * A narrow, mineflayer-free interface describing everything the bot can do.
 *
 * Skills depend on this rather than on `mineflayer`'s `Bot`, which means:
 *  - skills are unit-testable against a fake with no live server;
 *  - the mineflayer version can change without touching skill logic;
 *  - there is exactly one place that knows how to drive the real bot.
 */
import type { Vec3Like, BlockPos, EntitySummary, PlayerSummary, TimeOfDay } from './world.js';

export type Facing = 'north' | 'east' | 'south' | 'west';

export interface BlockRef {
  name: string;
  position: BlockPos;
  distance: number;
  /** Blocks with a non-solid shape (grass, torches) are not standable. */
  solid: boolean;
}

export interface InventoryEntry {
  item: string;
  count: number;
  slot: number;
}

export interface ChestRef {
  position: BlockPos;
  distance: number;
}

export interface NavigationOptions {
  signal?: AbortSignal;
  /** Give up and report rather than pathing forever. */
  timeoutMs?: number;
  /** Skip this many blocks vertically (stairs, ledges). */
  maxNodes?: number;
  /** Stop this many blocks short of the goal. */
  arriveDistance?: number;
  /** Avoid walking through these blocks entirely. */
  avoid?: readonly string[];
}

/** Result of a movement attempt. Never throws for ordinary pathing failure. */
export type MoveResult =
  | { status: 'arrived'; distance: number }
  | { status: 'blocked'; reason: string; stuckCount: number }
  | { status: 'unreachable'; reason: string }
  | { status: 'cancelled' };

export interface MinecraftFacade {
  readonly username: string;
  readonly dimension: string;

  // --- state -----------------------------------------------------------
  getPosition(): Vec3Like;
  getHealth(): { current: number; max: number };
  getHunger(): { current: number; saturation: number };
  isOnGround(): boolean;
  getTimeOfDay(): TimeOfDay;
  /** Entity id of the bot itself, used to ignore self in scans. */
  getEntityId(): number | undefined;

  // --- world queries ----------------------------------------------------
  getBlockAt(position: BlockPos): string | null;
  /** Is this block safe to stand on / break? Wraps the danger rules. */
  isDangerous(position: BlockPos): boolean;
  findNearestBlock(name: string, maxDistance: number): BlockRef | null;
  findBlocks(name: string, maxDistance: number, limit?: number): BlockRef[];
  /** Blocks near the bot worth telling the model about, grouped by name. */
  scanNearbyBlocks(radius: number): BlockRef[];
  getNearbyPlayers(maxDistance: number): PlayerSummary[];
  getNearbyEntities(maxDistance: number): EntitySummary[];
  getNearestPlayer(name: string): PlayerSummary | null;
  findNearestChest(maxDistance: number): ChestRef | null;

  // --- movement ---------------------------------------------------------
  moveToPosition(target: Vec3Like, options?: NavigationOptions): Promise<MoveResult>;
  moveToPlayer(player: string, options?: NavigationOptions): Promise<MoveResult>;
  stopMoving(): void;
  /** Current pathfinding goal, for stuck detection. */
  getGoal(): Vec3Like | null;
  lookAt(target: Vec3Like, force?: boolean): void;

  // --- actions ----------------------------------------------------------
  equipItem(item: string): Promise<boolean>;
  digBlock(position: BlockPos): Promise<boolean>;
  placeBlock(position: BlockPos, blockName: string, face?: 'top' | 'side' | 'front' | 'auto'): Promise<boolean>;
  attackEntity(entityId: number): void;
  useItem(): Promise<boolean>;
  eat(item?: string): Promise<boolean>;

  // --- inventory --------------------------------------------------------
  getInventory(): InventoryEntry[];
  countItem(item: string): number;
  /** Remove items; returns how many were actually dropped/transferred. */
  dropItem(item: string, count: number): Promise<number>;
  depositIntoChest(chest: BlockPos, item: string, count: number): Promise<number>;
  withdrawFromChest(chest: BlockPos, item: string, count: number): Promise<number>;
  /** Free slots, or null when unknown. */
  freeSlots(): number | null;
  heldItem(): string | null;
  /** Best available tool for a block, based on the held/target item. */
  selectToolFor(blockName: string): Promise<string | null>;

  // --- chat -------------------------------------------------------------
  chat(message: string): void;
}

/** Mutable state the bot needs outside the facade (task/memory oriented). */
export interface BotRuntimeState {
  followTarget: string | null;
  guardTarget: string | null;
  lastAuthorizedHumanSeen: number | null;
}