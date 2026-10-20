/**
 * The one and only place that knows about mineflayer.
 *
 * Everything above this layer talks to `MinecraftFacade`, which is why the
 * skills can be unit-tested without a server and the executor can be tested
 * with a plain object.
 */
import type { Bot as MineflayerBot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
// `goals` is a namespace on a CommonJS module: the named import compiles but
// does not exist at runtime (Node's CJS named-export detection cannot see it),
// so the namespace is taken from the default export instead.
import type { goals as PathfinderGoals } from 'mineflayer-pathfinder';
import pathfinderPackage from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import type { Vec3Like, BlockPos, EntitySummary, PlayerSummary, TimeOfDay } from '../types/world.js';
import { distance3 } from '../types/world.js';
import type {
  MinecraftFacade,
  MoveResult,
  NavigationOptions,
  BlockRef,
  ChestRef,
  DroppedItemRef,
  InventoryEntry,
} from '../types/facade.js';
import { MOVEMENT, DANGEROUS_BLOCKS, HOSTILE_MOB_FAMILIES } from '../config/constants.js';
import type { Logger } from '../utils/logger.js';
import { withTimeout, AbortedError } from '../utils/sleep.js';

/** The pathfinder's goal classes (GoalNear and friends). */
const goals = pathfinderPackage.goals;

/**
 * Single documented conversion point between our plain Vec3Like and the Vec3
 * class mineflayer expects. Confining the cast here keeps the rest of the file
 * honest and makes the library boundary easy to audit.
 */
function asVec3(point: Vec3Like): Vec3 {
  return new Vec3(point.x, point.y, point.z);
}

/** Stable key for a block position (used to remember the bot's own blocks). */
function blockKey(position: BlockPos): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

/** Blocks with non-solid collision shapes. */
const NON_SOLID = new Set([
  'air', 'cave_air', 'void_air', 'water', 'flowing_water', 'lava', 'flowing_lava',
  'grass', 'tall_grass', 'short_grass', 'vine', 'snow', 'torch', 'soul_torch',
  'rail', 'ladder', 'cobweb',
]);

const PASSIVE = new Set([
  'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey', 'mule',
  'wolf', 'cat', 'villager',
]);

/** Mineflayer entity name -> our coarse category. */
function categorize(name: string): EntitySummary['type'] {
  if (name === 'player') return 'player';
  if (name === 'item' || name === 'xp_orb' || name === 'arrow') return 'other';
  if (HOSTILE_MOB_FAMILIES.has(name)) return 'hostile';
  if (PASSIVE.has(name)) return 'passive';
  return 'other';
}

/**
 * The item inside a dropped-item entity.
 *
 * Item entities appear as soon as they are in range but their item metadata can
 * arrive a tick later, so this never throws and reports `unknown` rather than
 * breaking a whole world scan.
 */
function droppedItemName(entity: Entity): string {
  try {
    const dropped = entity.getDroppedItem();
    return dropped && typeof dropped.name === 'string' ? dropped.name : 'unknown';
  } catch {
    return 'unknown';
  }
}

export class MineflayerFacade implements MinecraftFacade {
  private readonly bot: MineflayerBot;
  private readonly logger: Logger;
  /** The last position the bot was actually at (never the world origin). */
  private lastPosition: Vec3Like = { x: 0, y: 0, z: 0 };
  /** Blocks the bot placed itself, so it never mines its own constructions. */
  private readonly ownBlocks = new Set<string>();

  constructor(bot: MineflayerBot, logger: Logger) {
    this.bot = bot;
    this.logger = logger.child({ component: 'facade' });
  }

  get username(): string {
    return this.bot.username;
  }

  get dimension(): string {
    return this.bot.game?.dimension ?? 'unknown';
  }

  /** Alias matching the WorldContextSource contract used by the AI layer. */
  getDimension(): string {
    return this.dimension;
  }

  getPosition(): Vec3Like {
    const p = this.bot.entity?.position;
    if (!p) {
      // Not spawned (or already disconnected): report the LAST known position
      // instead of the world origin, which would send the planner (and the
      // player) to 0,0,0.
      return { ...this.lastPosition };
    }
    this.lastPosition = { x: p.x, y: p.y, z: p.z };
    return { ...this.lastPosition };
  }

  getHealth(): { current: number; max: number } {
    return { current: this.bot.health ?? 0, max: 20 };
  }

  getHunger(): { current: number; saturation: number } {
    return { current: this.bot.food ?? 20, saturation: this.bot.foodSaturation ?? 5 };
  }

  isOnGround(): boolean {
    return this.bot.entity?.onGround ?? false;
  }

  getTimeOfDay(): TimeOfDay {
    // `bot.time.timeOfDay` is a TICK count (0..23999), not an enum: 0-11999 is
    // day, 12000-13999 dusk, 14000-22999 night, 23000-23999 dawn.
    const ticks = this.bot.time?.timeOfDay;
    if (typeof ticks !== 'number' || !Number.isFinite(ticks)) return 'unknown';
    const time = ((ticks % 24000) + 24000) % 24000;
    if (time < 12_000) return 'day';
    if (time < 14_000) return 'dusk';
    if (time < 23_000) return 'night';
    return 'dawn';
  }

  getEntityId(): number | undefined {
    return this.bot.entity?.id;
  }

  getBlockAt(position: BlockPos): string | null {
    const block = this.bot.blockAt(asVec3(position));
    return block ? block.name : null;
  }

  /**
   * True for blocks the bot placed itself.
   *
   * The bot remembers its own constructions so it never digs them up again:
   * without this, "build a wall" followed by "mine 20 cobblestone" would
   * demolish the wall the player just asked for.
   */
  isOwnBlock(position: BlockPos): boolean {
    return this.ownBlocks.has(blockKey(position));
  }

  isDangerous(position: BlockPos): boolean {
    const name = this.getBlockAt(position);
    if (name === null) return false;
    return DANGEROUS_BLOCKS.has(name) || name.includes('lava');
  }

  findNearestBlock(name: string, maxDistance: number): BlockRef | null {
    try {
      const found = this.bot.findBlock({ matching: (b) => b?.name === name, maxDistance });
      if (!found) return null;
      return this.toBlockRef(found.name, found.position);
    } catch (error) {
      // findBlock dereferences bot.entity: it throws when the bot is not
      // spawned, where its siblings findBlocks/scanNearbyBlocks return empty.
      this.logger.debug('nearest block lookup failed', {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  findBlocks(name: string, maxDistance: number, limit = 16): BlockRef[] {
    try {
      // findBlocks returns positions, so resolve each to a block for the name.
      const positions = this.bot.findBlocks({
        matching: (b) => b?.name === name,
        maxDistance,
        count: limit,
      });
      return positions
        .map((pos) => {
          const block = this.bot.blockAt(pos);
          return block ? this.toBlockRef(block.name, block.position) : null;
        })
        .filter((ref): ref is BlockRef => ref !== null);
    } catch (error) {
      this.logger.warn('block scan failed', {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  scanNearbyBlocks(radius: number): BlockRef[] {
    try {
      // One scan of positions, then de-duplicate by block name.
      const positions = this.bot.findBlocks({ matching: () => true, maxDistance: radius, count: 256 });
      const byName = new Map<string, BlockRef>();
      for (const pos of positions) {
        const block = this.bot.blockAt(pos);
        if (!block) continue;
        const candidate = this.toBlockRef(block.name, block.position);
        // findBlocks returns nearest-first, so keep the CLOSEST block of each
        // name: overwriting kept the farthest one, which fed wrong distances
        // to the planner.
        const existing = byName.get(block.name);
        if (existing && existing.distance <= candidate.distance) continue;
        byName.set(block.name, candidate);
      }
      return [...byName.values()].sort((a, b) => a.distance - b.distance);
    } catch (error) {
      this.logger.warn('nearby scan failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Mineflayer's `Block` has no distance field - compute it from the bot. */
  private toBlockRef(name: string, position: Vec3Like): BlockRef {
    return {
      name,
      position: { x: position.x, y: position.y, z: position.z },
      distance: distance3(this.getPosition(), position),
      solid: !NON_SOLID.has(name),
    };
  }

  /**
   * Every player that is ONLINE, according to the server's tab list.
   *
   * The tab list is the server's own list of connected players, independent
   * of distance - the only correct source for "is the owner still here?".
   * A spatial scan cannot answer that: an owner 200 blocks away in a mine is
   * online, and the bot must not hang up on them.
   */
  getOnlinePlayers(): Array<{ name: string }> {
    const out: Array<{ name: string }> = [];
    const self = this.bot.username;
    for (const player of Object.values(this.bot.players ?? {})) {
      const name = player?.username;
      if (typeof name !== 'string' || name.length === 0) continue;
      if (name === self) continue; // the bot is not a human
      out.push({ name });
    }
    return out;
  }

  getNearbyPlayers(maxDistance: number): PlayerSummary[] {
    const out: PlayerSummary[] = [];
    const selfId = this.getEntityId();
    for (const entity of Object.values(this.bot.entities ?? {})) {
      // A "player" entity in the entity table is a real online player.
      if (entity.type !== 'player' || entity.id === selfId || !entity.position) continue;
      const d = distance3(this.getPosition(), entity.position);
      if (d > maxDistance) continue;
      const name = this.resolvePlayerName(entity);
      // Until the tab list arrives, a player entity has no username and its
      // `name` is the literal "player" - reporting that as a player name
      // made the safe-mode monitor think nobody was online.
      if (name === null) continue;
      out.push({
        name,
        distance: d,
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        authorized: this.isAuthorizedName(name),
      });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  /**
   * Mineflayer's `Player` record has no position and the username lives on the
   * matching entity's username, so resolve through the entity id.
   *
   * Returns null when the name is genuinely unknown: the fallback `name` of a
   * player entity is the literal "player", which is worse than no name at all.
   */
  private resolvePlayerName(entity: Entity): string | null {
    if (entity.username !== undefined && entity.username !== null) return entity.username;
    const fallback = entity.displayName;
    if (typeof fallback === 'string' && fallback.length > 0 && fallback !== 'player') {
      return fallback;
    }
    return null;
  }

  /** Set by the bot so the facade can label players as authorized. */
  isAuthorizedName: (name: string) => boolean = () => false;

  getNearbyEntities(maxDistance: number): EntitySummary[] {
    const out: EntitySummary[] = [];
    const selfId = this.getEntityId();
    for (const entity of Object.values(this.bot.entities ?? {})) {
      if (entity.id === selfId) continue;
      if (!entity.position) continue;
      const d = distance3(this.getPosition(), entity.position);
      if (d > maxDistance) continue;
      const isPlayer = entity.type === 'player';
      const resolvedName = isPlayer ? this.resolvePlayerName(entity) : (entity.name ?? 'unknown');
      // A player whose name is not known yet is skipped rather than reported
      // under the literal name "player".
      if (resolvedName === null) continue;
      out.push({
        name: resolvedName,
        // A PLAYER is never a mob, whatever their name says: re-categorising
        // by name turned a player called "Slime" into a hostile mob.
        type: isPlayer ? 'player' : categorize(entity.name ?? 'unknown'),
        distance: d,
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        // The entity id is required to actually damage a mob (attack needs it).
        id: entity.id,
        ...(typeof entity.health === 'number' ? { health: entity.health } : {}),
      });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  getNearestPlayer(name: string): PlayerSummary | null {
    const target = name.toLowerCase();
    const selfId = this.getEntityId();
    for (const entity of Object.values(this.bot.entities ?? {})) {
      if (entity.type !== 'player' || entity.id === selfId || !entity.position) continue;
      const resolved = this.resolvePlayerName(entity);
      if (resolved === null || resolved.toLowerCase() !== target) continue;
      return {
        name: target,
        distance: distance3(this.getPosition(), entity.position),
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        authorized: this.isAuthorizedName(target),
      };
    }
    return null;
  }

  findNearestChest(maxDistance: number): ChestRef | null {
    try {
      const found = this.bot.findBlock({
        matching: (b) => b?.name === 'chest' || b?.name === 'barrel' || b?.name === 'trapped_chest',
        maxDistance,
      });
      if (!found) return null;
      return {
        position: { x: found.position.x, y: found.position.y, z: found.position.z },
        distance: distance3(this.getPosition(), found.position),
      };
    } catch (error) {
      // findBlock dereferences bot.entity: it throws when the bot is not
      // spawned (see findNearestBlock). The world context is built on every
      // AI request, so this must never throw.
      this.logger.debug('nearest chest lookup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  getNearbyDroppedItems(radius: number): DroppedItemRef[] {
    const out: DroppedItemRef[] = [];
    const selfId = this.getEntityId();
    const here = this.getPosition();
    for (const entity of Object.values(this.bot.entities ?? {})) {
      if (entity.id === selfId) continue;
      // Mineflayer names object entities by their object type: "item" is a
      // dropped stack, and only those can be picked up.
      if (entity.name !== 'item' || !entity.position) continue;
      const d = distance3(here, entity.position);
      if (d > radius) continue;
      out.push({
        name: droppedItemName(entity),
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        distance: d,
      });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  getInventory(): InventoryEntry[] {
    return this.bot.inventory.items().map((item) => ({
      item: item.name,
      count: item.count,
      slot: item.slot,
    }));
  }

  countItem(item: string): number {
    // `Window.count()` does `parseInt(itemType, 10)`: a NAME becomes NaN and
    // never matches an item id, so the count was silently always 0. Resolve
    // the name to its numeric id first.
    const id = this.itemId(item);
    if (id === null) return 0;
    return this.bot.inventory.count(id, null);
  }

  heldItem(): string | null {
    const held = this.bot.heldItem;
    return held ? held.name : null;
  }

  freeSlots(): number | null {
    // prismarine-windows exposes `emptySlotCount()`; there is no `freeSpace()`.
    const inv = this.bot.inventory as unknown as {
      emptySlotCount?: () => number;
      freeSpace?: () => number;
    };
    if (typeof inv.emptySlotCount === 'function') return inv.emptySlotCount();
    if (typeof inv.freeSpace === 'function') return inv.freeSpace();
    return null;
  }

  /**
   * Mineflayer's typed API wants numeric item ids, so resolve names through the
   * registry. Returns null for an unknown item rather than guessing.
   */
  private itemId(name: string): number | null {
    const item = this.bot.registry?.itemsByName?.[name];
    return item && typeof item.id === 'number' ? item.id : null;
  }

  private itemMeta(name: string): number | null {
    const item = this.bot.registry?.itemsByName?.[name];
    const meta = item?.metadata;
    return typeof meta === 'number' ? meta : null;
  }

  // --- movement ---------------------------------------------------------

  async moveToPosition(target: Vec3Like, options: NavigationOptions = {}): Promise<MoveResult> {
    const pathfinder = this.getPathfinder();
    if (!pathfinder) return { status: 'unreachable', reason: 'pathfinder not loaded' };

    const arriveDistance = options.arriveDistance ?? MOVEMENT.ARRIVE_DISTANCE;
    if (distance3(this.getPosition(), target) <= arriveDistance) {
      return { status: 'arrived', distance: 0 };
    }

    // Blocks the path must never cross (the "never route through lava"
    // promise). `Movements.blocksToAvoid` holds block IDS, so names are
    // resolved through the registry.
    this.applyAvoid(options.avoid);

    try {
      await withTimeout(
        pathfinder.goto(this.buildGoal(target, arriveDistance)),
        options.timeoutMs ?? MOVEMENT.PATH_TIMEOUT_MS,
        'pathfinding',
        options.signal,
      );
      this.bot.clearControlStates();
      const distance = distance3(this.getPosition(), target);
      if (distance <= arriveDistance + 1) return { status: 'arrived', distance };
      return { status: 'blocked', reason: 'did not reach target', stuckCount: 0 };
    } catch (error) {
      // The pathfinder keeps walking towards its goal after a timeout or a
      // cancellation: it re-applies the control states on every physics tick.
      // Stop it explicitly, or the bot walks off on its own. The goal is
      // cleared as well: a pending stop() poisons the NEXT walk.
      this.stopPathing();
      if (options.signal?.aborted || error instanceof AbortedError) {
        return { status: 'cancelled' };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/noPath|no path|too far/i.test(message)) {
        return { status: 'unreachable', reason: message };
      }
      return { status: 'blocked', reason: message, stuckCount: 0 };
    }
  }

  async moveToPlayer(player: string, options: NavigationOptions = {}): Promise<MoveResult> {
    const target = this.getNearestPlayer(player);
    if (!target) return { status: 'unreachable', reason: `player "${player}" is not online` };
    return this.moveToPosition(target.position, options);
  }

  stopMoving(): void {
    try {
      this.stopPathing();
      this.bot.clearControlStates();
    } catch (error) {
      this.logger.debug('stopMoving failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Stops the pathfinder AND clears the goal.
   *
   * `bot.pathfinder.stop()` only raises an internal flag; that flag is
   * cleared by the pathfinder's own stop(), which runs from resetPath - and
   * that path emits 'path_stop', which rejects the NEXT goto with "Path was
   * stopped". Clearing the goal right after the stop resets the flag, so the
   * following walk is not poisoned by this one. Without this, every new
   * request (which stops the body) broke the bot's ability to walk at all.
   */
  private stopPathing(): void {
    const pathfinder = this.getPathfinder();
    if (!pathfinder) return;
    pathfinder.stop();
    pathfinder.setGoal?.(null);
  }

  getGoal(): Vec3Like | null {
    const goal = this.getPathfinder()?.goal;
    return goal ? { x: goal.x, y: goal.y, z: goal.z } : null;
  }

  lookAt(target: Vec3Like, force = false): void {
    try {
      // `bot.lookAt` is async: a failure (the bot is not spawned yet, the
      // connection dropped) comes back as a REJECTION, which a synchronous
      // try/catch cannot see. Left unhandled it is an unhandled rejection,
      // and Node kills the process on those by default - a crash loop on a
      // hosted service.
      void Promise.resolve(this.bot.lookAt(asVec3(target), force)).catch((error: unknown) => {
        this.logger.debug('lookAt failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      this.logger.debug('lookAt failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getPathfinder(): PathfinderLike | undefined {
    return (this.bot as unknown as { pathfinder?: PathfinderLike }).pathfinder;
  }

  /**
   * Builds the pathfinder goal.
   *
   * `GoalNear` stops the bot `arriveDistance` short of the target. A plain
   * Vec3 goal walks onto the exact cell - for a follow that means walking INTO
   * the player and then shuffling back out again. The pathfinder also expects
   * a Goal object: a Vec3 has no `isValid()`, so every walk would throw
   * inside its tick handler.
   */
  private buildGoal(target: Vec3Like, arriveDistance: number): Vec3 | PathfinderGoals.Goal {
    if (arriveDistance <= 0) return asVec3(target);
    try {
      return new goals.GoalNear(target.x, target.y, target.z, arriveDistance);
    } catch (error) {
      this.logger.debug('GoalNear unavailable, walking to the exact target', {
        error: error instanceof Error ? error.message : String(error),
      });
      return asVec3(target);
    }
  }

  /**
   * Adds the blocks the path must never cross to the pathfinder's
   * `blocksToAvoid` (which holds block IDS, not names).
   */
  private applyAvoid(avoid: readonly string[] | undefined): void {
    if (!avoid || avoid.length === 0) return;
    const pathfinder = this.getPathfinder();
    const movements = (pathfinder as { movements?: { blocksToAvoid?: Set<number> } } | undefined)?.movements;
    const target = movements?.blocksToAvoid;
    if (!target) return;
    for (const name of avoid) {
      const block = this.bot.registry?.blocksByName?.[name];
      if (block && typeof block.id === 'number') target.add(block.id);
    }
  }

  // --- actions ----------------------------------------------------------

  async equipItem(item: string): Promise<boolean> {
    try {
      // `bot.equip` takes an Item object or a NUMERIC item id. A NAME is
      // rejected with "Invalid item object in equip", so the bot could never
      // hold anything - and without holding the block it could never place
      // one either. Resolve the name to its id first.
      const id = this.itemId(item);
      if (id === null) {
        this.logger.debug('unknown item name', { item });
        return false;
      }
      await this.bot.equip(id, 'hand');
      return true;
    } catch (error) {
      this.logger.debug('equip failed', {
        item,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async digBlock(position: BlockPos): Promise<boolean> {
    try {
      const block = this.bot.blockAt(asVec3(position));
      if (!block) return false;
      if (block.name === 'air' || block.name === 'cave_air') return false;
      await this.bot.dig(block, false);
      // The block is gone: it is no longer the bot's own.
      this.ownBlocks.delete(blockKey(position));
      return true;
    } catch (error) {
      this.logger.debug('dig failed', {
        position,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async placeBlock(
    position: BlockPos,
    blockName: string,
    face: 'top' | 'side' | 'front' | 'auto' = 'auto',
  ): Promise<boolean> {
    try {
      if (this.itemId(blockName) === null) {
        this.logger.warn('unknown block name', { blockName });
        return false;
      }
      // `bot.placeBlock(reference, faceVector)` puts the block at
      // reference + faceVector, so the CONTRACT "place at `position`" needs a
      // reference block ADJACENT to the target. Using the target itself as the
      // reference put every block one level above where it was asked for
      // (and inside the bot's own body when building at its feet).
      const target = { x: position.x, y: position.y, z: position.z };
      const candidates: Array<{ reference: Vec3Like; face: Vec3 }> = [];
      if (face === 'auto' || face === 'top') {
        candidates.push({ reference: { x: target.x, y: target.y - 1, z: target.z }, face: new Vec3(0, 1, 0) });
      }
      if (face === 'auto' || face === 'side') {
        candidates.push({ reference: { x: target.x + 1, y: target.y, z: target.z }, face: new Vec3(-1, 0, 0) });
        candidates.push({ reference: { x: target.x - 1, y: target.y, z: target.z }, face: new Vec3(1, 0, 0) });
      }
      if (face === 'auto' || face === 'front') {
        candidates.push({ reference: { x: target.x, y: target.y, z: target.z + 1 }, face: new Vec3(0, 0, -1) });
        candidates.push({ reference: { x: target.x, y: target.y, z: target.z - 1 }, face: new Vec3(0, 0, 1) });
      }

      for (const candidate of candidates) {
        const reference = this.bot.blockAt(asVec3(candidate.reference));
        if (!reference) continue;
        try {
          await this.bot.placeBlock(reference, candidate.face);
        } catch (error) {
          // `bot.placeBlock` REJECTS when the server refuses the placement
          // (an entity in the way, the wrong item in hand, ...). The other
          // references are still worth a try: every candidate puts the block
          // on the SAME target, but the server can accept one reference and
          // refuse another.
          this.logger.debug('placement against this reference failed', {
            position,
            blockName,
            reference: candidate.reference,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        // Remember what the bot built, so it never mines it up again.
        this.ownBlocks.add(blockKey(target));
        return true;
      }
      this.logger.debug('no reference block to place against', {
        position,
        blockName,
        face,
      });
      return false;
    } catch (error) {
      this.logger.debug('placeBlock failed', {
        position,
        blockName,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  attackEntity(entityId: number): void {
    const entity = this.bot.entities?.[entityId];
    if (!entity) return;
    try {
      this.bot.attack(entity);
    } catch (error) {
      this.logger.debug('attack failed', {
        entityId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  useItem(): Promise<boolean> {
    try {
      this.bot.activateItem();
      return Promise.resolve(true);
    } catch (error) {
      this.logger.debug('useItem failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return Promise.resolve(false);
    }
  }

  async eat(item?: string): Promise<boolean> {
    try {
      if (item !== undefined) {
        // Same contract as equipItem: `bot.equip` wants a numeric id, not a
        // name.
        const id = this.itemId(item);
        if (id === null) return false;
        await this.bot.equip(id, 'hand');
      }
      await this.bot.consume();
      return true;
    } catch (error) {
      this.logger.debug('eat failed', {
        item,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

// --- inventory --------------------------------------------------------

  async dropItem(item: string, count: number): Promise<number> {
    try {
      const itemType = this.itemId(item);
      if (itemType === null) return 0;
      const amount = Math.min(count, this.countItem(item));
      if (amount <= 0) return 0;
      await this.bot.toss(itemType, this.itemMeta(item), amount);
      return amount;
    } catch (error) {
      this.logger.debug('dropItem failed', {
        item,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  async depositIntoChest(chest: BlockPos, item: string, count: number): Promise<number> {
    const window = await this.openWindow(chest);
    if (!window) return 0;
    try {
      const itemType = this.itemId(item);
      if (itemType === null) return 0;
      const amount = Math.min(count, this.countItem(item));
      if (amount <= 0) return 0;
      await this.bot.transfer({
        window: window as never,
        itemType,
        metadata: this.itemMeta(item),
        count: amount,
        // Player inventory -> chest. `bot.transfer` REQUIRES a destination
        // range: without destStart it threw "destination full" and every
        // deposit failed.
        // The player's inventory inside a CONTAINER window does NOT start at
        // slot 9: a chest window puts the chest in 0..26 and the player's
        // inventory in 27..62 (63 exclusive).
        sourceStart: window.inventoryStart ?? 27,
        sourceEnd: window.inventoryEnd ?? 63,
        destStart: 0,
        destEnd: window.inventoryStart ?? 27,
      });
      return amount;
    } catch (error) {
      this.logger.warn('deposit failed', {
        item,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      window.close();
    }
  }

  async withdrawFromChest(chest: BlockPos, item: string, count: number): Promise<number> {
    const window = await this.openWindow(chest);
    if (!window) return 0;
    try {
      const itemType = this.itemId(item);
      if (itemType === null) return 0;
      const amount = Math.min(count, countWindowItem(window, item));
      if (amount <= 0) return 0;
      await this.bot.transfer({
        window: window as never,
        itemType,
        metadata: this.itemMeta(item),
        count: amount,
        // Chest -> player inventory.
        sourceStart: 0,
        sourceEnd: window.inventoryStart ?? 27,
        destStart: window.inventoryStart ?? 27,
        destEnd: window.inventoryEnd ?? 63,
      });
      return amount;
    } catch (error) {
      this.logger.warn('withdraw failed', {
        item,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      window.close();
    }
  }

  /** Opens a chest window, or null when it cannot be opened. */
  private async openWindow(position: BlockPos): Promise<WindowLike | null> {
    const block = this.bot.blockAt(asVec3(position));
    if (!block) return null;
    try {
      // Keep the window mineflayer opened: that is the one the deposit has
      // to close again. `bot.currentWindow` can already have been reset (a
      // close_window packet raced in), and then the container would be left
      // open on the server.
      const opened = (await this.bot.openContainer(block)) as unknown as WindowLike | null | undefined;
      if (opened) return opened;
      return (this.bot as unknown as { currentWindow?: WindowLike | null }).currentWindow ?? null;
    } catch (error) {
      this.logger.warn('could not open container', {
        position,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  selectToolFor(blockName: string): Promise<string | null> {
    // Mineflayer picks the best tool during dig(); we only short-circuit when
    // the bot is already holding something appropriate.
    const held = this.heldItem();
    if (held === null) return Promise.resolve(null);
    if (held.includes('pickaxe') && !blockName.includes('log')) return Promise.resolve(held);
    if (held.includes('axe') && blockName.includes('log')) return Promise.resolve(held);
    if (held.includes('shovel') && !blockName.includes('log')) return Promise.resolve(held);
    return Promise.resolve(null);
  }

  chat(message: string): void {
    this.bot.chat(message);
  }
}

/** Minimal structural view of the pathfinder plugin. */
interface PathfinderLike {
  goto(target: Vec3Like | PathfinderGoals.Goal): Promise<unknown>;
  stop(): void;
  goal?: Vec3Like;
  /** Clears the current goal; used to reset the pathfinder after a stop. */
  setGoal?(goal: unknown): void;
  movements?: { blocksToAvoid?: Set<number> };
}

interface WindowLike {
  close(): void;
  items(): Array<{ name: string; count: number }>;
  /** Slots of the container itself (a chest has 27). */
  containerItems?(): Array<{ name: string; count: number }>;
  /** First slot of the player's inventory inside this window. */
  inventoryStart?: number;
  /** Slot after the player's inventory inside this window. */
  inventoryEnd?: number;
}

/**
 * Counts an item inside the CONTAINER (the chest), not in the player's own
 * inventory region of the window: `window.items()` is the backpack, which is
 * why a withdraw used to compute the amount from the bot's own pockets.
 */
function countWindowItem(window: WindowLike, item: string): number {
  const slots = window.containerItems ? window.containerItems() : window.items();
  let total = 0;
  for (const slot of slots) {
    if (slot.name === item) total += slot.count;
  }
  return total;
}

