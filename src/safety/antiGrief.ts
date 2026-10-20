/**
 * Anti-grief rules.
 *
 * The bot works on a private server shared with real players, so it must
 * never quietly dismantle their work. It also keeps the bot from carving
 * tunnels through player builds just because the requested block is inside
 * one. Everything here is a pure, testable predicate.
 */
import type { BlockPos } from '../types/world.js';

/** Container/structural blocks that indicate a player-made build. */
const PLAYER_STRUCTURE_BLOCKS: ReadonlySet<string> = new Set([
  'chest',
  'trapped_chest',
  'ender_chest',
  'barrel',
  'dispenser',
  'dropper',
  'crafting_table',
  'furnace',
  'blast_furnace',
  'smoker',
  'anvil',
  'enchanting_table',
  'hopper',
  'note_block',
  'jukebox',
  'bed',
  'white_bed',
  'orange_bed',
  'magenta_bed',
  'light_blue_bed',
  'yellow_bed',
  'lime_bed',
  'pink_bed',
  'gray_bed',
  'light_gray_bed',
  'cyan_bed',
  'purple_bed',
  'blue_bed',
  'brown_bed',
  'green_bed',
  'red_bed',
  'black_bed',
  'beacon',
  'conduit',
  'lectern',
  'smithing_table',
  'loom',
  'grindstone',
  'stonecutter',
  'brewing_stand',
  'cauldron',
  'composter',
  'cartography_table',
  'item_frame',
  'painting',
  'flower_pot',
  'lantern',
  'soul_lantern',
  'torch',
  'soul_torch',
  'ladder',
  'sign',
  'oak_sign',
  'oak_wall_sign',
  'banner',
  'shulker_box',
]);

/** Blocks that are commonly part of a house/farm and should not be auto-mined. */
const PROTECTED_BLOCKS: ReadonlySet<string> = new Set([
  'farmland',
  'beetroots',
  'wheat',
  'carrots',
  'potatoes',
  'nether_wart',
  'sugar_cane',
  'bamboo',
  'cocoa',
  'melon_stem',
  'pumpkin_stem',
  'chest',
  'barrel',
  'furnace',
  'crafting_table',
  'bed',
  'torch',
  'ladder',
  'glass',
  'glass_pane',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
  'pale_oak_planks',
  'bamboo_planks',
  'crimson_planks',
  'warped_planks',
  'bookshelf',
  'chiseled_bookshelf',
  'scaffolding',
  'iron_bars',
  'crafter',
  'fletching_table',
  'decorated_pot',
  'cobblestone_wall',
  'stone_bricks',
  'bricks',
  'stonecutter',
]);

/**
 * Block families that always belong to a player build.
 *
 * The lists above name the blocks the bot meets most often, but a build is
 * made of whatever the player has: every wood has its own planks, every bed
 * its own colour and every wall its own name. The families below cover the
 * rest - the way the native client does - so a mangrove plank wall is
 * protected just like an oak one.
 */
const PLAYER_BUILD_FAMILIES: readonly string[] = [
  '_planks',
  '_bed',
  '_sign',
  '_banner',
  '_wall',
  '_shulker_box',
];

/** True for a block that belongs to a player build, whatever it is called. */
function isPlayerBuildBlock(name: string): boolean {
  return PLAYER_BUILD_FAMILIES.some((family) => name.endsWith(family));
}

/** Blocks the bot may always break without asking (nature only). */
const NATURAL_BLOCKS: ReadonlySet<string> = new Set([
  'stone',
  'cobblestone',
  'deepslate',
  'dirt',
  'grass_block',
  'sand',
  'gravel',
  'clay',
  'andesite',
  'diorite',
  'granite',
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'coal_ore',
  'iron_ore',
  'copper_ore',
  'gold_ore',
  'diamond_ore',
  'redstone_ore',
  'lapis_ore',
  'emerald_ore',
  'tall_grass',
  'short_grass',
  'dead_bush',
  'oak_leaves',
  'birch_leaves',
  'spruce_leaves',
  'gravel',
  'netherrack',
  'end_stone',
  'obsidian',
]);

/**
 * Blocks the bot may build into: empty space and the vegetation/fluids that
 * a build would legitimately replace.
 */
const REPLACEABLE_TARGETS: ReadonlySet<string> = new Set([
  'air',
  'cave_air',
  'void_air',
  'water',
  'lava',
  'grass',
  'short_grass',
  'tall_grass',
  'snow',
  'fire',
]);

export interface AntiGriefContext {
  /** Blocks the bot believes a player placed. Updated by the world tracker. */
  protectedBlocks?: ReadonlySet<string>;
  /** Chests and other containers that belong to players. */
  playerContainers?: ReadonlySet<string>;
  /** Distance from a player, used to stay out of their way. */
  nearestPlayerDistance?: number;
}

export interface AntiGriefDecision {
  allowed: boolean;
  reason?: string;
  /** True when we could proceed but should ask a human first. */
  requiresConfirmation?: boolean;
}

function posKey(p: BlockPos): string {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

/**
 * How close a block may be to a player container and still count as part of
 * that player's structure.
 *
 * A chest is the one thing the bot can always recognise as somebody's, and
 * a build is bigger than the chest: the walls around it belong to the same
 * player.
 */
const STRUCTURE_RADIUS = 2;

/**
 * True when the block sits inside the structure of a player-owned container.
 *
 * Natural terrain is excluded on purpose: the bot has to be able to dig
 * stone, even next to somebody's chest.
 */
function insidePlayerStructure(position: BlockPos, context: AntiGriefContext): boolean {
  const containers = context.playerContainers;
  if (containers === undefined) return false;
  const x = Math.floor(position.x);
  const y = Math.floor(position.y);
  const z = Math.floor(position.z);
  for (const key of containers) {
    const parts = key.split(',');
    if (parts.length !== 3) continue;
    const cx = Number(parts[0]);
    const cy = Number(parts[1]);
    const cz = Number(parts[2]);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) continue;
    if (
      Math.abs(cx - x) <= STRUCTURE_RADIUS &&
      Math.abs(cy - y) <= STRUCTURE_RADIUS &&
      Math.abs(cz - z) <= STRUCTURE_RADIUS
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The anti-grief rules.
 *
 * The class holds no state: every decision is a pure function of the block
 * name, the position and the context that is passed in. That is what lets the
 * executor and the skills each hold their own instance and still reach exactly
 * the same verdict.
 */
export class AntiGriefRules {
  /**
   * May the bot break this block?
   *
   * Policy: natural terrain is always fine. Anything a player placed, and
   * anything inside a structure containing player containers, is refused
   * unless an authorized player explicitly asked for it.
   */
  canBreakBlock(
    blockName: string,
    position: BlockPos,
    context: AntiGriefContext = {},
    explicitlyRequested = false,
  ): AntiGriefDecision {
    const key = posKey(position);

    if (context.protectedBlocks?.has(key)) {
      return explicitlyRequested
        ? { allowed: true, reason: 'player block broken because explicitly requested' }
        : { allowed: false, reason: 'refusing to break a block placed by a player' };
    }

    if (PLAYER_STRUCTURE_BLOCKS.has(blockName)) {
      return { allowed: false, reason: `refusing to break player structure block "${blockName}"` };
    }

    // A block inside the structure of a player container belongs to that
    // player, whatever it is made of. This is what keeps the bot from
    // carving a tunnel through somebody's base just because the block it
    // was asked for happens to be inside it.
    if (!NATURAL_BLOCKS.has(blockName) && insidePlayerStructure(position, context)) {
      return explicitlyRequested
        ? { allowed: true, reason: 'player structure broken because explicitly requested' }
        : { allowed: false, reason: `refusing to break "${blockName}" inside a player's structure` };
    }

    const protectedByName = PROTECTED_BLOCKS.has(blockName) || isPlayerBuildBlock(blockName);
    if (protectedByName && !NATURAL_BLOCKS.has(blockName)) {
      return explicitlyRequested
        ? { allowed: true }
        : { allowed: false, reason: `refusing to break protected block "${blockName}"` };
    }

    if (NATURAL_BLOCKS.has(blockName)) return { allowed: true };
    return { allowed: true };
  }

  /**
   * May the bot open this chest?
   *
   * `mode` says what the chest is wanted for:
   *  - `read` - taking items out (or just looking): a player-owned chest may
   *    be opened, but only to read it;
   *  - `write` - putting items in: a player-owned chest is off limits, the
   *    bot must never fill somebody else's storage with its own loot.
   */
  canOpenChest(
    position: BlockPos,
    context: AntiGriefContext = {},
    mode: 'read' | 'write' = 'read',
  ): AntiGriefDecision {
    if (context.playerContainers?.has(posKey(position))) {
      if (mode === 'write') {
        return { allowed: false, reason: 'refusing to store items in a player-owned chest' };
      }
      return { allowed: true, reason: 'player-owned chest (read-only unless asked)' };
    }
    return { allowed: true };
  }

  /**
   * Should the bot back off because a human is standing where it wants to work?
   * Keeps the bot from mining into someone's feet.
   */
  shouldYieldToPlayer(context: AntiGriefContext = {}): boolean {
    const d = context.nearestPlayerDistance;
    return d !== undefined && d < 1.5;
  }

  /** Placeable? Only on air/replaceable, never inside a player container. */
  canPlaceBlock(_position: BlockPos, existing: string | null): AntiGriefDecision {
    if (existing === null || REPLACEABLE_TARGETS.has(existing)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `target position is occupied by "${existing}"` };
  }
}

export { NATURAL_BLOCKS, PLAYER_STRUCTURE_BLOCKS, PROTECTED_BLOCKS };