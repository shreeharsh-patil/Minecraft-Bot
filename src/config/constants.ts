/**
 * Shared constants. Pure data only - no side effects, no imports.
 */

/** Prefix that marks a deterministic (non-AI) command. Mirrors BOT_PREFIX. */
export const DEFAULT_BOT_PREFIX = '!';
// NOTE: the AI action allowlist lives in `src/types/actions.ts` (`ACTION_TYPES`).
// Do not duplicate it here - there was an older copy that drifted stale.

/**
 * Conflict groups. Only one task per group may hold the bot at a time,
 * which is what stops "follow me" and "mine 20 logs" from fighting.
 */
export const CONFLICT_GROUP = {
  MOVEMENT: 'movement',
  MINING: 'mining',
  BUILDING: 'building',
  INVENTORY: 'inventory',
  COMBAT: 'combat',
  NONE: 'none',
} as const;

/** Blocks that should never be walked into, dug through, or stood on. */
export const DANGEROUS_BLOCKS: ReadonlySet<string> = new Set([
  'lava',
  'flowing_lava',
  'fire',
  'soul_fire',
  'magma_block',
  'campfire',
  'soul_campfire',
  'cactus',
  'powder_snow',
  'sweet_berry_bush',
  'wither_rose',
  'water',
  'flowing_water',
  'tnt',
]);

/** Hostile mob families. Used by survival + world scanning. */
export const HOSTILE_MOB_FAMILIES: ReadonlySet<string> = new Set([
  'zombie',
  'skeleton',
  'creeper',
  'spider',
  'cave_spider',
  'enderman',
  'witch',
  'husk',
  'stray',
  'wither_skeleton',
  'slime',
  'magma_cube',
  'blaze',
  'silverfish',
  'endermite',
  'guardian',
  'phantom',
  'piglin_brute',
  'drowned',
  'zoglin',
  'hoglin',
  'warden',
  'evoker',
  'vex',
  'ravager',
  'pillager',
  'vindicator',
  'breeze',
]);

/** Tools preferred per block, best first. Keeps tool choice deterministic. */
export const BLOCK_TOOL: Readonly<Record<string, readonly string[]>> = {
  oak_log: ['axe'],
  birch_log: ['axe'],
  spruce_log: ['axe'],
  jungle_log: ['axe'],
  acacia_log: ['axe'],
  dark_oak_log: ['axe'],
  mangrove_log: ['axe'],
  cherry_log: ['axe'],
  stone: ['pickaxe'],
  cobblestone: ['pickaxe'],
  deepslate: ['pickaxe'],
  andesite: ['pickaxe'],
  diorite: ['pickaxe'],
  granite: ['pickaxe'],
  calcite: ['pickaxe'],
  obsidian: ['pickaxe', 'diamond_pickaxe'],
  iron_ore: ['pickaxe'],
  gold_ore: ['pickaxe'],
  diamond_ore: ['pickaxe'],
  coal_ore: ['pickaxe'],
  copper_ore: ['pickaxe'],
  redstone_ore: ['pickaxe'],
  lapis_ore: ['pickaxe'],
  emerald_ore: ['pickaxe'],
  netherrack: ['pickaxe'],
  end_stone: ['pickaxe'],
  sandstone: ['pickaxe'],
  dirt: ['shovel'],
  sand: ['shovel'],
  gravel: ['shovel'],
  clay: ['shovel'],
  grass_block: ['shovel'],
  snow: ['shovel'],
};

/** Blocks that are typically safe to mine without a tool. */
export const SOFT_BLOCKS: ReadonlySet<string> = new Set([
  'dirt',
  'grass_block',
  'sand',
  'gravel',
  'clay',
  'snow',
  'snow_block',
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'cobweb',
  'tall_grass',
  'short_grass',
  'vine',
  'lily_pad',
  'stone',
  'cobblestone',
]);

/** Edible foods, best (safest, highest restore) first. */
export const FOODS: readonly string[] = [
  'golden_carrot',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'cooked_mutton',
  'cooked_rabbit',
  'cooked_salmon',
  'cooked_cod',
  'bread',
  'apple',
  'baked_potato',
  'carrot',
  'beetroot',
  'melon_slice',
  'sweet_berries',
  'cookie',
  'dried_kelp',
  'rotten_flesh',
];

/** Movement tuning. Chosen to look deliberate rather than twitchy. */
export const MOVEMENT = {
  /** How close the bot tries to get to a target position. */
  ARRIVE_DISTANCE: 1.5,
  /** Pathfinding hard timeout - a stuck bot must never hang a task. */
  PATH_TIMEOUT_MS: 20_000,
  /** Max consecutive stuck detections before the task gives up. */
  MAX_STUCK_ATTEMPTS: 3,
  /** Distance beyond which follow mode recalculates its path. */
  FOLLOW_REPATH_DISTANCE: 4,
  /** Min distance the follow mode keeps - never stand inside the player. */
  FOLLOW_STOP_DISTANCE: 2,
  /** How often follow mode re-evaluates its target. */
  FOLLOW_TICK_MS: 1_000,
  /** Jump cooldown - prevents constant hopping on flat ground. */
  JUMP_COOLDOWN_MS: 450,
  /** Fall distance (blocks) that counts as a dangerous drop. */
  DANGEROUS_FALL_DISTANCE: 4,
  /** Reposition to this distance when stuck rather than hammering a wall. */
  STUCK_REPOSITION_DISTANCE: 2,
  /** Block scan radius for local world queries. */
  SCAN_RADIUS: 6,
} as const;

/** Timing constants for the chat/bot layer. */
export const BOT_TIMING = {
  /** Periodic heartbeat interval. */
  TICK_MS: 1_000,
  /** How often authorized-human presence is re-evaluated. */
  PRESENCE_CHECK_MS: 5_000,
  /** Chat responses are spaced out so the server does not flag spam. */
  CHAT_SEND_INTERVAL_MS: 400,
} as const;

/** Provider names known to the router. */
export const PROVIDER_NAMES = ['openai', 'gemini', 'groq', 'openrouter'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];