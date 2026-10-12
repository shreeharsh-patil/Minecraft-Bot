/**
 * An in-memory `MinecraftFacade` test double.
 *
 * Written by hand so the skills can be exercised without a server, a socket or
 * a mineflayer dependency. It models just enough of the world for the skill
 * layer: blocks, entities, players, chests, inventory and movement, plus call
 * recording so tests can assert on what the skill actually did.
 *
 * Abort handling mirrors the real facade contract: navigation calls return
 * `{status:'cancelled'}` when the signal fires while in flight.
 */
import { DANGEROUS_BLOCKS } from '../../../src/config/constants.js';
import type {
  BlockRef,
  ChestRef,
  DroppedItemRef,
  InventoryEntry,
  MinecraftFacade,
  MoveResult,
  NavigationOptions,
} from '../../../src/types/facade.js';
import type { BlockPos, EntitySummary, PlayerSummary, TimeOfDay, Vec3Like } from '../../../src/types/world.js';
import { distance3 } from '../../../src/types/world.js';
import { AbortedError, sleep } from '../../../src/utils/sleep.js';

export interface FakeWorldInit {
  position?: Vec3Like;
  blocks?: Array<{ name: string; at: BlockPos }>;
  entities?: EntitySummary[];
  players?: PlayerSummary[];
  chests?: Array<{ at: BlockPos; items?: Record<string, number> }>;
  /** Dropped stacks on the ground, as a death pile or a spill would leave. */
  droppedItems?: Array<{ name: string; at: BlockPos }>;
  inventory?: Record<string, number>;
  /** blockName -> tool the facade should select, e.g. { oak_log: 'iron_axe' }. */
  tools?: Record<string, string>;
  hunger?: number;
  health?: number;
  /** Total inventory slots; drives `freeSlots()`. */
  slots?: number;
}

const NON_SOLID: ReadonlySet<string> = new Set([
  'air',
  'torch',
  'grass',
  'short_grass',
  'tall_grass',
  'fire',
  'lava',
  'water',
  'flowing_water',
  'snow',
]);

function key(p: Vec3Like): string {
  return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
}

/** How close the bot must get before Minecraft hands it a dropped stack. */
const PICKUP_RADIUS = 1;

export class FakeMinecraftFacade implements MinecraftFacade {
  public readonly username = 'TestBot';
  public readonly dimension = 'overworld';

  // --- world state ------------------------------------------------------
  public position: Vec3Like;
  public hunger: number;
  public health: number;
  public readonly slots: number;
  private readonly blocks = new Map<string, string>();
  private readonly inventoryMap = new Map<string, number>();
  private readonly chestMap = new Map<string, Map<string, number>>();
  /** Dropped stacks keyed by position - mineflayer keeps one entity per stack. */
  private readonly droppedMap = new Map<string, string>();
  private readonly entities: EntitySummary[];
  private readonly players: PlayerSummary[];
  private readonly tools: Record<string, string>;
  private held: string | null = null;

  // --- instrumentation --------------------------------------------------
  public readonly calls: string[] = [];
  public readonly moveToPositionCalls: Array<{ target: Vec3Like; options?: NavigationOptions }> = [];
  public readonly moveToPlayerCalls: Array<{ player: string; options?: NavigationOptions }> = [];
  public readonly lookTargets: Vec3Like[] = [];
  public readonly dugPositions: BlockPos[] = [];
  public readonly placedPositions: Array<{ at: BlockPos; block: string }> = [];
  public readonly attackedIds: number[] = [];
  public readonly equippedItems: string[] = [];
  public readonly chatMessages: string[] = [];
  public readonly dropped: Array<{ item: string; count: number }> = [];
  /** Stacks the bot walked over and collected, i.e. what `pickup_items` gained. */
  public readonly pickedUp: Array<{ item: string; count: number }> = [];
  public stopMovingCount = 0;

  // --- behaviour switches ------------------------------------------------
  /** Delay applied to navigation calls, for cancellation tests. */
  public moveDelayMs = 0;
  /** Delay applied to dig calls, for cancellation tests. */
  public digDelayMs = 0;
  /** Block names that cannot be dug (e.g. missing tool). */
  public readonly undiggable = new Set<string>();
  /** Positions that cannot be pathed to. */
  public readonly unreachable = new Set<string>();
  /** When true `freeSlots()` reports a full inventory. */
  public inventoryFull = false;
  /** When true every path request fails as unreachable. */
  public pathfindingFails = false;
  /** Per-step chunk sizes of each deposit, for stack-behaviour assertions. */
  public readonly depositTrace: number[] = [];
  /** Total chest capacity; deposit stops when it is reached. */
  public chestCapacity = 1728;
  public goal: Vec3Like | null = null;

  constructor(init: FakeWorldInit = {}) {
    this.position = { ...(init.position ?? { x: 0, y: 64, z: 0 }) };
    this.hunger = init.hunger ?? 20;
    this.health = init.health ?? 20;
    this.slots = init.slots ?? 36;
    this.tools = init.tools ?? {};
    this.entities = init.entities ?? [];
    this.players = init.players ?? [];

    for (const block of init.blocks ?? []) this.blocks.set(key(block.at), block.name);
    for (const [item, count] of Object.entries(init.inventory ?? {})) this.addItem(item, count);
    for (const chest of init.chests ?? []) {
      this.chestMap.set(key(chest.at), new Map(Object.entries(chest.items ?? {})));
    }
    for (const dropped of init.droppedItems ?? []) this.droppedMap.set(key(dropped.at), dropped.name);
  }

  // --- test helpers -------------------------------------------------------
  public addBlock(name: string, at: BlockPos): void {
    this.blocks.set(key(at), name);
  }

  public removeBlock(at: BlockPos): void {
    this.blocks.delete(key(at));
  }

  public setPosition(p: Vec3Like): void {
    this.position = { ...p };
  }

  public addItem(item: string, count: number): void {
    this.inventoryMap.set(item, (this.inventoryMap.get(item) ?? 0) + count);
  }

  public setItem(item: string, count: number): void {
    if (count <= 0) this.inventoryMap.delete(item);
    else this.inventoryMap.set(item, count);
  }

  public movePlayer(player: string, to: Vec3Like): void {
    const existing = this.players.find((p) => p.name.toLowerCase() === player.toLowerCase());
    if (existing) {
      existing.position = { ...to };
      existing.distance = distance3(this.position, existing.position);
    }
  }

  public removePlayer(player: string): void {
    const index = this.players.findIndex((p) => p.name.toLowerCase() === player.toLowerCase());
    if (index >= 0) this.players.splice(index, 1);
  }

  public removeEntity(entityName: string): void {
    const index = this.entities.findIndex((e) => e.name === entityName);
    if (index >= 0) this.entities.splice(index, 1);
  }

  /** Chest contents, for assertions. */
  public chestContents(at: BlockPos): Record<string, number> {
    return Object.fromEntries(this.chestMap.get(key(at)) ?? new Map<string, number>());
  }

  /** Drops a stack on the ground, e.g. the aftermath of a player death. */
  public addDroppedItem(name: string, at: BlockPos): void {
    this.droppedMap.set(key(at), name);
  }

  public removeDroppedItem(at: BlockPos): void {
    this.droppedMap.delete(key(at));
  }

  /** Positions of the stacks still lying on the ground, for assertions. */
  public droppedItemPositions(): BlockPos[] {
    const positions: BlockPos[] = [];
    for (const droppedKey of this.droppedMap.keys()) {
      const position = this.parseKey(droppedKey);
      if (position !== null) positions.push(position);
    }
    return positions;
  }

  // --- state --------------------------------------------------------------
  public getPosition(): Vec3Like {
    return { ...this.position };
  }

  public getHealth(): { current: number; max: number } {
    return { current: this.health, max: 20 };
  }

  public getHunger(): { current: number; saturation: number } {
    return { current: this.hunger, saturation: 5 };
  }

  public isOnGround(): boolean {
    return true;
  }

  public getTimeOfDay(): TimeOfDay {
    return 'day';
  }

  public getEntityId(): number | undefined {
    return 1;
  }

  // --- world queries ------------------------------------------------------
  public getBlockAt(position: BlockPos): string | null {
    return this.blocks.get(key(position)) ?? 'air';
  }

  public isDangerous(position: BlockPos): boolean {
    const name = this.getBlockAt(position);
    return name !== null && DANGEROUS_BLOCKS.has(name);
  }

  public findNearestBlock(name: string, maxDistance: number): BlockRef | null {
    return this.findBlocks(name, maxDistance, 1)[0] ?? null;
  }

  public findBlocks(name: string, maxDistance: number, limit?: number): BlockRef[] {
    const found: BlockRef[] = [];
    for (const [blockKey, blockName] of this.blocks) {
      if (blockName !== name) continue;
      const position = this.parseKey(blockKey);
      if (position === null) continue;
      const distance = distance3(this.position, position);
      if (distance > maxDistance) continue;
      found.push({ name: blockName, position, distance, solid: !NON_SOLID.has(blockName) });
    }
    found.sort((a, b) => a.distance - b.distance);
    return limit === undefined ? found : found.slice(0, limit);
  }

  public scanNearbyBlocks(radius: number): BlockRef[] {
    const found: BlockRef[] = [];
    for (const [blockKey, blockName] of this.blocks) {
      const position = this.parseKey(blockKey);
      if (position === null) continue;
      const distance = distance3(this.position, position);
      if (distance > radius) continue;
      found.push({ name: blockName, position, distance, solid: !NON_SOLID.has(blockName) });
    }
    return found.sort((a, b) => a.distance - b.distance);
  }

  public getNearbyPlayers(maxDistance: number): PlayerSummary[] {
    return this.players
      .map((p) => ({ ...p, distance: distance3(this.position, p.position) }))
      .filter((p) => p.distance <= maxDistance);
  }

  public getNearbyEntities(maxDistance: number): EntitySummary[] {
    return this.entities
      .map((e) => ({ ...e, distance: distance3(this.position, e.position) }))
      .filter((e) => e.distance <= maxDistance);
  }

  public getNearestPlayer(name: string): PlayerSummary | null {
    const matches = this.getNearbyPlayers(Number.POSITIVE_INFINITY)
      .filter((p) => p.name.toLowerCase() === name.toLowerCase())
      .sort((a, b) => a.distance - b.distance);
    return matches[0] ?? null;
  }

  public findNearestChest(maxDistance: number): ChestRef | null {
    let best: ChestRef | null = null;
    for (const chestKey of this.chestMap.keys()) {
      const position = this.parseKey(chestKey);
      if (position === null) continue;
      const distance = distance3(this.position, position);
      if (distance > maxDistance) continue;
      if (best === null || distance < best.distance) best = { position, distance };
    }
    return best;
  }

  public getNearbyDroppedItems(radius: number): DroppedItemRef[] {
    this.calls.push('getNearbyDroppedItems');
    const found: DroppedItemRef[] = [];
    for (const [droppedKey, name] of this.droppedMap) {
      const position = this.parseKey(droppedKey);
      if (position === null) continue;
      const distance = distance3(this.position, position);
      if (distance > radius) continue;
      found.push({ name, position, distance });
    }
    return found.sort((a, b) => a.distance - b.distance);
  }

  private parseKey(blockKey: string): BlockPos | null {
    const parts = blockKey.split(',').map((n) => Number(n));
    const [x, y, z] = parts;
    if (x === undefined || y === undefined || z === undefined) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x, y, z };
  }

  // --- movement -----------------------------------------------------------
  public async moveToPosition(target: Vec3Like, options?: NavigationOptions): Promise<MoveResult> {
    this.calls.push('moveToPosition');
    this.moveToPositionCalls.push({ target: { ...target }, ...(options ? { options } : {}) });
    if (options?.signal?.aborted) return { status: 'cancelled' };

    if (this.moveDelayMs > 0) {
      try {
        await sleep(this.moveDelayMs, options?.signal);
      } catch (error) {
        if (error instanceof AbortedError) return { status: 'cancelled' };
        throw error;
      }
    }
    if (options?.signal?.aborted) return { status: 'cancelled' };

    if (this.pathfindingFails || this.unreachable.has(key(target))) {
      return { status: 'unreachable', reason: `no path to ${key(target)}` };
    }
    this.position = { ...target };
    this.goal = { ...target };
    // Minecraft hands a stack to a player who walks within a block of it, which
    // is precisely the mechanic `pickup_items` relies on.
    this.collectDroppedItems();
    return { status: 'arrived', distance: 0 };
  }

  /** Collects every stack now within pickup range, as the real game would. */
  private collectDroppedItems(): void {
    if (this.inventoryFull) return;
    for (const [droppedKey, name] of [...this.droppedMap]) {
      const position = this.parseKey(droppedKey);
      if (position === null) continue;
      if (distance3(this.position, position) > PICKUP_RADIUS) continue;
      this.droppedMap.delete(droppedKey);
      this.addItem(name, 1);
      this.pickedUp.push({ item: name, count: 1 });
    }
  }

  public async moveToPlayer(player: string, options?: NavigationOptions): Promise<MoveResult> {
    this.calls.push('moveToPlayer');
    this.moveToPlayerCalls.push({ player, ...(options ? { options } : {}) });
    if (options?.signal?.aborted) return { status: 'cancelled' };

    const sighting = this.getNearestPlayer(player);
    if (!sighting) return { status: 'unreachable', reason: `${player} is not online` };

    const arrive = options?.arriveDistance ?? 1.5;
    const distance = distance3(this.position, sighting.position);
    if (distance <= arrive) return { status: 'arrived', distance };

    // Stop `arrive` blocks short, like a real arriveDistance-aware pathfinder.
    const backOff = arrive / distance;
    const stopAt: Vec3Like = {
      x: sighting.position.x + (this.position.x - sighting.position.x) * backOff,
      y: sighting.position.y + (this.position.y - sighting.position.y) * backOff,
      z: sighting.position.z + (this.position.z - sighting.position.z) * backOff,
    };
    const result = await this.moveToPosition(stopAt, options);
    if (result.status === 'arrived') return { status: 'arrived', distance: arrive };
    return result;
  }

  public stopMoving(): void {
    this.calls.push('stopMoving');
    this.stopMovingCount += 1;
    this.goal = null;
  }

  public getGoal(): Vec3Like | null {
    return this.goal;
  }

  public lookAt(target: Vec3Like): void {
    this.calls.push('lookAt');
    this.lookTargets.push({ ...target });
  }

  // --- actions ------------------------------------------------------------
  // These are synchronous in memory, so they resolve immediately rather than
  // pretending to be async.
  public equipItem(item: string): Promise<boolean> {
    this.calls.push(`equipItem:${item}`);
    return Promise.resolve(this.inventoryMap.has(item) && this.holdItem(item));
  }

  private holdItem(item: string): boolean {
    if (!this.inventoryMap.has(item)) return false;
    this.held = item;
    this.equippedItems.push(item);
    return true;
  }

  public async digBlock(position: BlockPos): Promise<boolean> {
    this.calls.push('digBlock');
    const name = this.getBlockAt(position);
    if (name === null || name === 'air') return false;
    if (this.undiggable.has(name)) return false;
    if (this.digDelayMs > 0) await sleep(this.digDelayMs);
    this.blocks.set(key(position), 'air');
    this.dugPositions.push({ ...position });
    this.addItem(name, 1);
    return true;
  }

  public placeBlock(position: BlockPos, blockName: string): Promise<boolean> {
    this.calls.push(`placeBlock:${blockName}`);
    const have = this.inventoryMap.get(blockName) ?? 0;
    if (have <= 0) return Promise.resolve(false);
    if (have === 1) this.inventoryMap.delete(blockName);
    else this.inventoryMap.set(blockName, have - 1);
    this.blocks.set(key(position), blockName);
    this.placedPositions.push({ at: { ...position }, block: blockName });
    return Promise.resolve(true);
  }

  public attackEntity(entityId: number): void {
    this.calls.push(`attackEntity:${entityId}`);
    this.attackedIds.push(entityId);
  }

  public useItem(): Promise<boolean> {
    this.calls.push('useItem');
    return Promise.resolve(true);
  }

  public eat(item?: string): Promise<boolean> {
    this.calls.push('eat');
    const food = item ?? this.held;
    if (food === null) return Promise.resolve(false);
    const have = this.inventoryMap.get(food) ?? 0;
    if (have <= 0) return Promise.resolve(false);
    if (have === 1) this.inventoryMap.delete(food);
    else this.inventoryMap.set(food, have - 1);
    this.hunger = Math.min(20, this.hunger + 6);
    return Promise.resolve(true);
  }

  // --- inventory ----------------------------------------------------------
  public getInventory(): InventoryEntry[] {
    let slot = 0;
    const entries: InventoryEntry[] = [];
    for (const [item, count] of this.inventoryMap) {
      entries.push({ item, count, slot });
      slot += 1;
    }
    return entries;
  }

  public countItem(item: string): number {
    return this.inventoryMap.get(item) ?? 0;
  }

  public dropItem(item: string, count: number): Promise<number> {
    this.calls.push(`dropItem:${item}`);
    const have = this.inventoryMap.get(item) ?? 0;
    const moved = Math.max(0, Math.min(count, have));
    if (moved === 0) return Promise.resolve(0);
    const left = have - moved;
    if (left === 0) this.inventoryMap.delete(item);
    else this.inventoryMap.set(item, left);
    this.dropped.push({ item, count: moved });
    return Promise.resolve(moved);
  }

  public depositIntoChest(chest: BlockPos, item: string, count: number): Promise<number> {
    this.calls.push(`depositIntoChest:${item}`);
    const contents = this.chestMap.get(key(chest));
    if (!contents) return Promise.resolve(0);

    const have = this.inventoryMap.get(item) ?? 0;
    if (have <= 0) return Promise.resolve(0);

    // Fill existing stacks (max 64 each) before opening a new one.
    let stored = 0;
    for (const [name, quantity] of contents) {
      if (stored >= count) break;
      const stackRoom = Math.max(0, 64 - quantity);
      const space = Math.min(count - stored, stackRoom, this.chestCapacity - this.chestSize(contents));
      if (space <= 0) continue;
      contents.set(name, quantity + space);
      stored += space;
      this.depositTrace.push(space);
    }
    if (stored < count && this.chestSize(contents) < this.chestCapacity) {
      const space = Math.min(count - stored, this.chestCapacity - this.chestSize(contents));
      if (space > 0) {
        contents.set(item, (contents.get(item) ?? 0) + space);
        stored += space;
        this.depositTrace.push(space);
      }
    }
    if (stored === 0) return Promise.resolve(0);

    const left = have - stored;
    if (left === 0) this.inventoryMap.delete(item);
    else this.inventoryMap.set(item, left);
    return Promise.resolve(stored);
  }

  public withdrawFromChest(chest: BlockPos, item: string, count: number): Promise<number> {
    this.calls.push(`withdrawFromChest:${item}`);
    const contents = this.chestMap.get(key(chest));
    if (!contents) return Promise.resolve(0);

    const have = contents.get(item) ?? 0;
    if (have <= 0) return Promise.resolve(0);
    const room = this.inventoryFull ? 0 : Math.max(0, this.slots - this.inventoryMap.size);
    const moved = Math.min(count, have, room);
    if (moved <= 0) return Promise.resolve(0);

    contents.set(item, have - moved);
    if (contents.get(item) === 0) contents.delete(item);
    this.addItem(item, moved);
    return Promise.resolve(moved);
  }

  public freeSlots(): number | null {
    if (this.inventoryFull) return 0;
    return Math.max(0, this.slots - this.inventoryMap.size);
  }

  public heldItem(): string | null {
    return this.held;
  }

  public selectToolFor(blockName: string): Promise<string | null> {
    this.calls.push(`selectToolFor:${blockName}`);
    return Promise.resolve(this.tools[blockName] ?? null);
  }

  // --- chat ---------------------------------------------------------------
  public chat(message: string): void {
    this.chatMessages.push(message);
  }

  private chestSize(contents: Map<string, number>): number {
    let total = 0;
    for (const quantity of contents.values()) total += quantity;
    return total;
  }
}