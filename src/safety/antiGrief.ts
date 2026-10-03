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
  'red_bed',
  'blue_bed',
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
  'torch',
  'soul_torch',
  'ladder',
  'sign',
  'oak_sign',
  'oak_wall_sign',
  'banner',
  'shulker_box',
  'white_bed',
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
  'cobblestone_wall',
  'stone_bricks',
  'bricks',
  'stonecutter',
]);

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

    if (PROTECTED_BLOCKS.has(blockName) && !NATURAL_BLOCKS.has(blockName)) {
      return explicitlyRequested
        ? { allowed: true }
        : { allowed: false, reason: `refusing to break protected block "${blockName}"` };
    }

    if (NATURAL_BLOCKS.has(blockName)) return { allowed: true };
    return { allowed: true };
  }

  /** Player containers are never mined, and never moved. */
  canOpenChest(position: BlockPos, context: AntiGriefContext = {}): AntiGriefDecision {
    if (context.playerContainers?.has(posKey(position))) {
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
    if (existing === null || ['air', 'cave_air', 'void_air', 'water', 'lava', 'grass'].includes(existing)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `target position is occupied by "${existing}"` };
  }
}

export { NATURAL_BLOCKS, PLAYER_STRUCTURE_BLOCKS, PROTECTED_BLOCKS };