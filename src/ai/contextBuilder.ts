/**
 * Builds the compact world payload shown to the model.
 *
 * Deliberately mineflayer-free: every value arrives through an injected
 * function, so this module is unit-testable without a live server and the
 * mineflayer version can change without touching it.
 *
 * Hard rule: SMALL. The model never sees the raw world, entity lists or full
 * inventories - only ranked, truncated summaries.
 */
import type { EntitySummary, PlayerSummary, TimeOfDay, Vec3Like } from '../types/world.js';
import { roundPos } from '../types/world.js';
import { DANGEROUS_BLOCKS } from '../config/constants.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';

/** Everything the builder needs, all injected. No mineflayer import. */
export interface WorldContextSource {
  getPosition(): Vec3Like;
  getDimension(): string;
  getTimeOfDay(): TimeOfDay;
  getHealth(): { current: number; max: number };
  getHunger(): { current: number; saturation: number };
  /** Players within `maxDistance`. */
  getNearbyPlayers(maxDistance: number): PlayerSummary[];
  /** Entities within `maxDistance` (hostile/passive/neutral). */
  getNearbyEntities(maxDistance: number): EntitySummary[];
  /** Interesting blocks within `radius`, already ranked by the facade. */
  scanNearbyBlocks(radius: number): Array<{ name: string; distance: number; position: Vec3Like }>;
  /** Full inventory entries (already summarised by the facade). */
  getInventory(): Array<{ item: string; count: number; slot: number }>;
  heldItem(): string | null;
  /** The task currently owning the bot, if any. */
  getCurrentTask?(): string | null;
}

export interface ContextMemorySource {
  readonly targetPlayer?: string | null;
  /** Rolling chat window, newest last. */
  readonly conversation?: ReadonlyArray<{ player: string; text: string; at: number }>;
  readonly objective?: string | null;
}

export interface ContextLimits {
  maxPlayers: number;
  maxHostiles: number;
  maxBlocks: number;
  maxInventoryItems: number;
  maxConversationTurns: number;
  /** How far away a reported entity/block may be. */
  scanRadius: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  maxPlayers: 5,
  maxHostiles: 5,
  maxBlocks: 8,
  maxInventoryItems: 12,
  maxConversationTurns: 6,
  scanRadius: 16,
};

/**
 * Clamps a limit to a usable, non-negative integer.
 *
 * The limits are the whole point of this module, so a nonsense value must
 * never make the payload BIGGER: `slice(0, -1)` keeps everything but the
 * last item, `slice(-0)` is `slice(0)` and returns the whole array, and
 * `Infinity` means "no limit at all". A limit of 0 has to mean "none".
 */
function limitOf(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** What the planner hands to the model. Serialisable and small by construction. */
export interface CompactContext {
  position: Vec3Like;
  dimension: string;
  timeOfDay: TimeOfDay;
  health: { current: number; max: number };
  hunger: { current: number; saturation: number };
  task: string | null;
  targetPlayer: string | null;
  nearbyPlayers: Array<{ name: string; distance: number; authorized: boolean; health?: number }>;
  nearbyHostiles: Array<{ name: string; distance: number; health?: number }>;
  nearbyBlocks: Array<{ name: string; distance: number }>;
  dangerousBlocksNearby: string[];
  inventory: {
    held: string | null;
    usedSlots: number;
    freeSlots: number | null;
    items: Array<{ name: string; count: number }>;
  };
  recentChat: Array<{ player: string; text: string }>;
}

export interface ContextBuilderOptions {
  limits?: Partial<ContextLimits>;
  logger?: Logger;
}

/** Clamps chat text so a wall of text can never blow the token budget. */
const MAX_CHAT_CHARS = 160;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Ranks blocks by usefulness to a decision: dangerous blocks hoisted to the
 * top, then nearest first, de-duplicated by name so the model sees
 * "oak_log at ~6 blocks" rather than thirty near-identical rows.
 */
function rankBlocks(
  blocks: ReadonlyArray<{ name: string; distance: number }>,
  limits: ContextLimits,
): { nearby: Array<{ name: string; distance: number }>; dangerous: string[] } {
  const seen = new Set<string>();
  const dangerous = new Set<string>();
  const ranked: Array<{ name: string; distance: number }> = [];

  for (const block of [...blocks].sort((a, b) => {
    const aDanger = DANGEROUS_BLOCKS.has(a.name) ? 0 : 1;
    const bDanger = DANGEROUS_BLOCKS.has(b.name) ? 0 : 1;
    if (aDanger !== bDanger) return aDanger - bDanger;
    return a.distance - b.distance;
  })) {
    if (DANGEROUS_BLOCKS.has(block.name)) dangerous.add(block.name);
    if (seen.has(block.name)) continue;
    seen.add(block.name);
    if (ranked.length >= limits.maxBlocks) continue;
    ranked.push({ name: block.name, distance: round1(block.distance) });
  }
  return { nearby: ranked, dangerous: [...dangerous] };
}

export function buildCompactContext(
  world: WorldContextSource,
  memory?: ContextMemorySource,
  options: ContextBuilderOptions = {},
): CompactContext {
  // Every limit is clamped: a negative or non-finite limit would otherwise
  // make the slices below KEEP MORE than was asked for.
  const limits: ContextLimits = {
    maxPlayers: limitOf(options.limits?.maxPlayers, DEFAULT_CONTEXT_LIMITS.maxPlayers),
    maxHostiles: limitOf(options.limits?.maxHostiles, DEFAULT_CONTEXT_LIMITS.maxHostiles),
    maxBlocks: limitOf(options.limits?.maxBlocks, DEFAULT_CONTEXT_LIMITS.maxBlocks),
    maxInventoryItems: limitOf(options.limits?.maxInventoryItems, DEFAULT_CONTEXT_LIMITS.maxInventoryItems),
    maxConversationTurns: limitOf(
      options.limits?.maxConversationTurns,
      DEFAULT_CONTEXT_LIMITS.maxConversationTurns,
    ),
    scanRadius: limitOf(options.limits?.scanRadius, DEFAULT_CONTEXT_LIMITS.scanRadius),
  };
  const logger = options.logger ?? silentLogger;

  // Every injected function is defensive: a throwing facade must not take the
  // whole AI request down, so each is wrapped and degrades to a safe default.
  const safe = <T>(label: string, fallback: T, fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      logger.warn('context source failed', {
        label,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  };

  const position = safe('position', { x: 0, y: 64, z: 0 }, () => roundPos(world.getPosition()));
  const dimension = safe('dimension', 'unknown', () => world.getDimension());
  const timeOfDay = safe('timeOfDay', 'unknown', () => world.getTimeOfDay());
  const health = safe('health', { current: 20, max: 20 }, () => world.getHealth());
  const hunger = safe('hunger', { current: 20, saturation: 5 }, () => world.getHunger());

  const players = safe<PlayerSummary[]>('players', [], () => world.getNearbyPlayers(limits.scanRadius));
  const entities = safe<EntitySummary[]>('entities', [], () => world.getNearbyEntities(limits.scanRadius));
  const blocks = safe<Array<{ name: string; distance: number; position: Vec3Like }>>('blocks', [], () =>
    world.scanNearbyBlocks(limits.scanRadius),
  );
  const inventory = safe<Array<{ item: string; count: number; slot: number }>>(
    'inventory',
    [],
    () => world.getInventory(),
  );
  const held = safe<string | null>('held', null, () => world.heldItem());
  const task = safe<string | null>('task', null, () => world.getCurrentTask?.() ?? null);

  const hostiles = entities
    .filter((entity) => entity.type === 'hostile')
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limits.maxHostiles)
    .map((entity) => ({
      name: entity.name,
      distance: round1(entity.distance),
      ...(entity.health !== undefined ? { health: entity.health } : {}),
    }));

  const rankedBlocks = rankBlocks(blocks, limits);

  // The rolling session state is injected too, so it gets the same
  // treatment: a malformed chat window must not take the request down.
  const conversation = safe<ReadonlyArray<{ player: string; text: string; at: number }>>(
    'conversation',
    [],
    () => memory?.conversation ?? [],
  );
  const targetPlayer = safe<string | null>('targetPlayer', null, () => memory?.targetPlayer ?? null);
  // A limit of 0 means "no chat at all": `slice(-0)` is `slice(0)` and
  // would return the WHOLE window.
  const recentChat = safe<Array<{ player: string; text: string }>>('recentChat', [], () =>
    (limits.maxConversationTurns > 0 ? conversation.slice(-limits.maxConversationTurns) : []).map((turn) => ({
      player: turn.player,
      text: turn.text.slice(0, MAX_CHAT_CHARS),
    })),
  );

  return {
    position,
    dimension,
    timeOfDay,
    health,
    hunger,
    task,
    targetPlayer,
    nearbyPlayers: [...players]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limits.maxPlayers)
      .map((player) => ({
        name: player.name,
        distance: round1(player.distance),
        authorized: player.authorized,
        ...(player.health !== undefined ? { health: player.health } : {}),
      })),
    nearbyHostiles: hostiles,
    nearbyBlocks: rankedBlocks.nearby,
    dangerousBlocksNearby: rankedBlocks.dangerous,
    inventory: {
      held,
      usedSlots: inventory.length,
      freeSlots: null,
      items: [...inventory]
        .sort((a, b) => b.count - a.count)
        .slice(0, limits.maxInventoryItems)
        .map((entry) => ({ name: entry.item, count: entry.count })),
    },
    recentChat,
  };
}