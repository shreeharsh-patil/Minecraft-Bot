/**
 * The one and only place that knows about mineflayer.
 *
 * Everything above this layer talks to `MinecraftFacade`, which is why the
 * skills can be unit-tested without a server and the executor can be tested
 * with a plain object.
 */
import type { Bot as MineflayerBot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import { Vec3 } from 'vec3';
import type { Vec3Like, BlockPos, EntitySummary, PlayerSummary, TimeOfDay } from '../types/world.js';
import { distance3 } from '../types/world.js';
import type {
  MinecraftFacade,
  MoveResult,
  NavigationOptions,
  BlockRef,
  ChestRef,
  InventoryEntry,
} from '../types/facade.js';
import { MOVEMENT, DANGEROUS_BLOCKS, HOSTILE_MOB_FAMILIES } from '../config/constants.js';
import type { Logger } from '../utils/logger.js';
import { withTimeout, AbortedError } from '../utils/sleep.js';

/**
 * Single documented conversion point between our plain Vec3Like and the Vec3
 * class mineflayer expects. Confining the cast here keeps the rest of the file
 * honest and makes the library boundary easy to audit.
 */
function asVec3(point: Vec3Like): Vec3 {
  return new Vec3(point.x, point.y, point.z);
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

export class MineflayerFacade implements MinecraftFacade {
  private readonly bot: MineflayerBot;
  private readonly logger: Logger;

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
    return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 0, z: 0 };
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
    switch (this.bot.time?.timeOfDay) {
      case 0: return 'day';
      case 1: return 'dusk';
      case 2: return 'night';
      default: return 'unknown';
    }
  }

  getEntityId(): number | undefined {
    return this.bot.entity?.id;
  }

  getBlockAt(position: BlockPos): string | null {
    const block = this.bot.blockAt(asVec3(position));
    return block ? block.name : null;
  }

  isDangerous(position: BlockPos): boolean {
    const name = this.getBlockAt(position);
    if (name === null) return false;
    return DANGEROUS_BLOCKS.has(name) || name.includes('lava');
  }

  findNearestBlock(name: string, maxDistance: number): BlockRef | null {
    const found = this.bot.findBlock({ matching: (b) => b?.name === name, maxDistance });
    if (!found) return null;
    return this.toBlockRef(found.name, found.position);
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
        const existing = byName.get(block.name);
        if (existing && existing.distance <= 0) continue;
        byName.set(block.name, this.toBlockRef(block.name, block.position));
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

  getNearbyPlayers(maxDistance: number): PlayerSummary[] {
    const out: PlayerSummary[] = [];
    const selfId = this.getEntityId();
    for (const entity of Object.values(this.bot.entities ?? {})) {
      // A "player" entity in the entity table is a real online player.
      if (entity.type !== 'player' || entity.id === selfId || !entity.position) continue;
      const d = distance3(this.getPosition(), entity.position);
      if (d > maxDistance) continue;
      const name = this.resolvePlayerName(entity);
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
   */
  private resolvePlayerName(entity: Entity): string {
    if (entity.username !== undefined && entity.username !== null) return entity.username;
    return entity.name ?? entity.displayName ?? 'unknown';
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
      out.push({
        name: entity.type === 'player' ? this.resolvePlayerName(entity) : (entity.name ?? 'unknown'),
        type: categorize(entity.name ?? 'unknown'),
        distance: d,
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
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
      if (this.resolvePlayerName(entity).toLowerCase() !== target) continue;
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
    const found = this.bot.findBlock({
      matching: (b) => b?.name === 'chest' || b?.name === 'barrel' || b?.name === 'trapped_chest',
      maxDistance,
    });
    if (!found) return null;
    return {
      position: { x: found.position.x, y: found.position.y, z: found.position.z },
      distance: distance3(this.getPosition(), found.position),
    };
  }

  getInventory(): InventoryEntry[] {
    return this.bot.inventory.items().map((item) => ({
      item: item.name,
      count: item.count,
      slot: item.slot,
    }));
  }

  countItem(item: string): number {
    return this.bot.inventory.count(item, null);
  }

  heldItem(): string | null {
    const held = this.bot.heldItem;
    return held ? held.name : null;
  }

  freeSlots(): number | null {
    // prismarine-inventory exposes freeSpace on the bot's main inventory window.
    const inv = this.bot.inventory as unknown as { freeSpace?: () => number };
    return typeof inv.freeSpace === 'function' ? inv.freeSpace() : null;
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

    try {
      await withTimeout(
        pathfinder.goto(asVec3(target)),
        options.timeoutMs ?? MOVEMENT.PATH_TIMEOUT_MS,
        'pathfinding',
        options.signal,
      );
      this.bot.clearControlStates();
      const distance = distance3(this.getPosition(), target);
      if (distance <= arriveDistance + 1) return { status: 'arrived', distance };
      return { status: 'blocked', reason: 'did not reach target', stuckCount: 0 };
    } catch (error) {
      this.bot.clearControlStates();
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
      this.getPathfinder()?.stop();
      this.bot.clearControlStates();
    } catch (error) {
      this.logger.debug('stopMoving failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getGoal(): Vec3Like | null {
    const goal = this.getPathfinder()?.goal;
    return goal ? { x: goal.x, y: goal.y, z: goal.z } : null;
  }

  lookAt(target: Vec3Like, force = false): void {
    try {
      void this.bot.lookAt(asVec3(target), force);
    } catch (error) {
      this.logger.debug('lookAt failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getPathfinder(): PathfinderLike | undefined {
    return (this.bot as unknown as { pathfinder?: PathfinderLike }).pathfinder;
  }

  // --- actions ----------------------------------------------------------

  async equipItem(item: string): Promise<boolean> {
    try {
      await this.bot.equip(item as never, 'hand');
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
      const reference = this.bot.blockAt(asVec3(position));
      if (!reference) return false;
      if (this.itemId(blockName) === null) {
        this.logger.warn('unknown block name', { blockName });
        return false;
      }
      // placeBlock(referenceBlock, faceVector): the vector points off the
      // reference block toward where the new block should appear.
      const vectors: Record<string, Vec3> = {
        top: new Vec3(0, 1, 0),
        side: new Vec3(1, 0, 0),
        front: new Vec3(0, 0, 1),
      };
      const faceVector = face === 'auto' ? new Vec3(0, 1, 0) : (vectors[face] ?? new Vec3(0, 1, 0));
      await this.bot.placeBlock(reference, faceVector);
      return true;
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
      if (item !== undefined) await this.bot.equip(item as never, 'hand');
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
      await this.bot.transfer(({
        window: window as never,
        itemType,
        metadata: this.itemMeta(item),
        count: amount,
        sourceStart: 9,
        sourceEnd: 35,
      }) as never);
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
      await this.bot.transfer(({
        window: window as never,
        itemType,
        metadata: this.itemMeta(item),
        count: amount,
        sourceStart: 0,
        sourceEnd: 26,
      }) as never);
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
      await this.bot.openContainer(block);
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
  goto(target: Vec3Like): Promise<unknown>;
  stop(): void;
  goal?: Vec3Like;
}

interface WindowLike {
  close(): void;
  items(): Array<{ name: string; count: number }>;
}

function countWindowItem(window: WindowLike, item: string): number {
  let total = 0;
  for (const slot of window.items()) {
    if (slot.name === item) total += slot.count;
  }
  return total;
}

