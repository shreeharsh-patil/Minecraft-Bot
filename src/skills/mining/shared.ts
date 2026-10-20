import { BLOCK_TOOL, SOFT_BLOCKS } from '../../config/constants.js';
import type { BlockRef, InventoryEntry, MinecraftFacade } from '../../types/facade.js';
import type { ExecutionContext } from '../../types/task.js';
import { AntiGriefRules } from '../../safety/antiGrief.js';
import { DEFAULT_MAX_MINE } from '../../safety/actionLimits.js';
import { createLogger } from '../../utils/logger.js';
import {
  ACTION_TIMEOUT_MS,
  approachBlock,
  formatPos,
  guardedOp,
  isDangerousBlock,
  normaliseBlockName,
  posKey,
  reportProgress,
} from '../internal/helpers.js';

const log = createLogger({ level: 'info' }).child({ layer: 'skills', skill: 'mining' });

/** Absolute ceiling for one mining task, whatever the model asked for. */
export const MAX_BLOCKS_PER_TASK = DEFAULT_MAX_MINE;
/** How far to look for the next block of the requested type. */
export const SEARCH_DISTANCE = 24;
/** Consecutive per-block failures tolerated before the task gives up. */
export const MAX_MINING_FAILURES = 8;

export interface MineRunResult {
  /** Blocks actually broken. */
  mined: number;
  /** Target that was requested (already clamped). */
  target: number;
  /** True when the loop ended because `ctx.signal` fired. */
  cancelled: boolean;
  /** Why the loop stopped, when it was not simply "target reached". */
  reason: string | null;
}

export interface MineRunOptions {
  /** Candidate block names, tried in order (e.g. all wood types). */
  names: readonly string[];
  /** How many blocks to break. */
  count: number;
  /** Noun used in messages, e.g. "oak logs". */
  label: string;
  searchDistance?: number;
  /** The anti-grief rules that decide which blocks may be broken. */
  rules?: AntiGriefRules;
}

type ToolOutcome =
  | { status: 'ok'; value: string | null }
  | { status: 'cancelled' }
  | { status: 'error'; reason: string };

/**
 * The one and only mining loop in the codebase.
 *
 * `mineBlock` and `collectResource` both delegate here, so the mining logic
 * (search -> approach -> tool -> dig -> count -> progress) exists exactly once.
 */
export async function runMining(
  facade: MinecraftFacade,
  ctx: ExecutionContext,
  options: MineRunOptions,
): Promise<MineRunResult> {
  const searchDistance = options.searchDistance ?? SEARCH_DISTANCE;
  const rules = options.rules ?? new AntiGriefRules();
  const tried = new Set<string>();
  let mined = 0;
  let failures = 0;
  let cancelled = false;
  let reason: string | null = null;
  /** Why the last block was left alone, if any. */
  let refusal: string | null = null;

  while (mined < options.count) {
    if (ctx.signal.aborted) {
      cancelled = true;
      break;
    }

    const target = pickNextBlock(facade, options.names, searchDistance, tried);
    if (!target) {
      // A specific failure ("no pickaxe", "that chest is not mine to break")
      // is more useful than "ran out".
      reason ??= refusal ?? `I ran out of ${options.label} within ${searchDistance} blocks.`;
      break;
    }
    tried.add(posKey(target.position));

    // Anti-grief: a block a player placed (a chest, a farm, a plank wall)
    // is never broken, even when the model asked for that exact block.
    const grief = rules.canBreakBlock(target.name, target.position);
    if (!grief.allowed) {
      refusal ??= grief.reason ?? `I won't break that ${target.name}.`;
      log.debug('refusing to break block', {
        block: target.name,
        at: formatPos(target.position),
        reason: grief.reason,
      });
      continue;
    }

    const arrival = await approachBlock(facade, ctx, target.position, `Approaching ${target.name}`);
    if (arrival.status === 'cancelled') {
      cancelled = true;
      break;
    }
    if (arrival.status !== 'arrived') {
      failures += 1;
      log.debug('could not reach block', { block: target.name, at: formatPos(target.position) });
      if (failures >= MAX_MINING_FAILURES) {
        reason = `I couldn't reach the remaining ${options.label}.`;
        break;
      }
      continue;
    }

    const tool = await equipToolFor(facade, ctx, target);
    if (tool.status === 'cancelled') {
      cancelled = true;
      break;
    }
    if (tool.status === 'error') {
      failures += 1;
      reason = tool.reason;
      if (failures >= MAX_MINING_FAILURES) break;
      continue;
    }

    const dug = await guardedOp(
      () => facade.digBlock(target.position),
      ctx,
      `Digging ${target.name}`,
      ACTION_TIMEOUT_MS,
    );
    if (dug.status === 'cancelled') {
      cancelled = true;
      break;
    }
    if (dug.status === 'ok' && dug.value) {
      mined += 1;
      failures = 0;
      reportProgress(ctx, mined, options.count, `Mined ${mined}/${options.count} ${options.label}`);
      continue;
    }

    failures += 1;
    reason = `I couldn't break that ${target.name} at ${formatPos(target.position)}.`;
    // A block with a preferred tool that we could not select means we are
    // holding the wrong thing - say so instead of failing silently.
    if (tool.value === null) {
      const wanted = BLOCK_TOOL[target.name];
      if (wanted !== undefined) {
        reason += ` I have no ${wanted[0] ?? 'suitable tool'} for it.`;
      }
    }
    if (failures >= MAX_MINING_FAILURES) break;
  }

  return { mined, target: options.count, cancelled, reason };
}

/**
 * How many candidates of one block type the search looks at.
 *
 * The window is widened when every block in it turned out to be unusable -
 * the bot's own constructions, a player's build, a block that could not be
 * broken. Those blocks stay in the world, so a fixed window of the nearest
 * blocks runs out while minable blocks are still within reach, and the bot
 * would report "I ran out of cobblestone" with the cobblestone right there.
 */
const CANDIDATE_WINDOWS: readonly number[] = [16, 64, 256];

/** Nearest untried block matching any candidate name. */
function pickNextBlock(
  facade: MinecraftFacade,
  names: readonly string[],
  searchDistance: number,
  tried: ReadonlySet<string>,
): BlockRef | null {
  for (const limit of CANDIDATE_WINDOWS) {
    const best = nearestCandidate(facade, names, searchDistance, tried, limit);
    if (best !== null) return best;
  }
  return null;
}

/** Nearest untried block matching any candidate name, inside one window. */
function nearestCandidate(
  facade: MinecraftFacade,
  names: readonly string[],
  searchDistance: number,
  tried: ReadonlySet<string>,
  limit: number,
): BlockRef | null {
  let best: BlockRef | null = null;
  for (const name of names) {
    for (const candidate of facade.findBlocks(name, searchDistance, limit)) {
      if (tried.has(posKey(candidate.position))) continue;
      if (isDangerousBlock(candidate.name)) continue;
      // Never mine the bot's own construction: "build a wall" followed by
      // "mine 20 cobblestone" must not demolish the wall.
      if (facade.isOwnBlock(candidate.position)) continue;
      if (best === null || candidate.distance < best.distance) best = candidate;
    }
  }
  return best;
}

const ALL_LOG_TYPES: readonly string[] = [
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
];

/**
 * Turns a human phrase ("oak logs", "some cobblestone", "wood") into candidate
 * Minecraft block names. Returns an empty array when nothing plausible exists.
 */
export function resolveResourceNames(resource: string): string[] {
  const cleaned = normaliseBlockName(resource);
  if (cleaned.length === 0) return [];

  const words = cleaned.split('_').filter((w) => w.length > 0);
  const last = words[words.length - 1];

  // "oak logs" -> oak_log, "birch wood" -> birch_log
  if (words.length > 1 && (last === 'logs' || last === 'log')) {
    return [`${words.slice(0, -1).join('_')}_log`];
  }
  // "birch wood" is the other word people use for a log. Only a known
  // species is mapped, so "bamboo wood" does not become the non-existent
  // "bamboo_log".
  if (words.length > 1 && (last === 'wood' || last === 'woods')) {
    const species = words.slice(0, -1).join('_');
    if (ALL_LOG_TYPES.includes(`${species}_log`)) return [`${species}_log`];
  }

  switch (cleaned) {
    case 'log':
    case 'logs':
    case 'wood':
    case 'timber':
      return [...ALL_LOG_TYPES];
    case 'plank':
    case 'planks':
      return ALL_LOG_TYPES.map((t) => t.replace('_log', '_planks'));
    case 'stone':
    case 'rocks':
      return ['stone'];
    case 'dirt':
    case 'soil':
    case 'earth':
      return ['dirt', 'grass_block'];
    case 'sand':
      return ['sand', 'sandstone'];
    case 'gravel':
      return ['gravel'];
    case 'coal':
      return ['coal_ore'];
    case 'iron':
      return ['iron_ore'];
    case 'gold':
      return ['gold_ore'];
    case 'diamond':
      return ['diamond_ore'];
    case 'copper':
      return ['copper_ore'];
    case 'redstone':
      return ['redstone_ore'];
    case 'lapis':
      return ['lapis_ore'];
    case 'emerald':
      return ['emerald_ore'];
    default:
      break;
  }

  // Known mineable block, or already a valid block name (e.g. "cobblestone").
  if (BLOCK_TOOL[cleaned] !== undefined || SOFT_BLOCKS.has(cleaned)) return [cleaned];
  return /^[a-z]+(_[a-z]+)*$/.test(cleaned) ? [cleaned] : [];
}

/** Human-friendly label for chat: "oak_log" -> "oak logs". */
export function humaniseBlockName(name: string): string {
  const normalised = normaliseBlockName(name);
  if (normalised.endsWith('_log')) return `${normalised.slice(0, -4).replace(/_/g, ' ')} logs`;
  return normalised.replace(/_/g, ' ');
}

/**
 * Tool tiers, best first: a wooden pickaxe mines nothing that needs iron.
 */
const TOOL_TIERS: readonly string[] = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

/** The tool noun of a family: "axe", "pickaxe", "diamond_pickaxe" -> "pickaxe". */
function toolNoun(family: string): string {
  const words = family.split('_');
  return words[words.length - 1] ?? family;
}

/** How good a tool is: 0 is the best (netherite), -1 is not a tiered tool. */
function toolTier(item: string): number {
  const words = item.split('_');
  return TOOL_TIERS.indexOf(words[0] ?? '');
}

/**
 * Does this item serve the tool family a block needs?
 *
 * "iron_pickaxe" is a pickaxe but NOT an axe: a plain substring match would
 * call a pickaxe an axe and the bot would chop logs with it. A family that
 * names a tier ("diamond_pickaxe") asks for at least that tier, so a
 * netherite pickaxe still counts.
 */
function servesToolFamily(item: string, family: string): boolean {
  const noun = toolNoun(family);
  if (item !== noun && !item.endsWith(`_${noun}`)) return false;
  const required = TOOL_TIERS.indexOf(family.split('_')[0] ?? '');
  if (required < 0) return true;
  const tier = toolTier(item);
  return tier >= 0 && tier <= required;
}

/**
 * The best tool of the families the block needs that the bot owns, or null
 * when it owns none. The families are tried in order - `BLOCK_TOOL` lists
 * them best first.
 */
function bestToolInInventory(
  facade: MinecraftFacade,
  families: readonly string[],
): string | null {
  let entries: InventoryEntry[] = [];
  try {
    entries = facade.getInventory();
  } catch {
    // A facade that cannot list the inventory leaves the bot with whatever
    // it is already holding.
    return null;
  }
  for (const family of families) {
    let best: string | null = null;
    let bestTier = Number.POSITIVE_INFINITY;
    for (const entry of entries) {
      if (!servesToolFamily(entry.item, family)) continue;
      const tier = toolTier(entry.item);
      if (tier < bestTier) {
        best = entry.item;
        bestTier = tier;
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/**
 * Picks the right tool for a block via `selectToolFor` and equips it.
 *
 * The facade only offers the tool the bot is already holding, and that tool
 * may be the wrong one for this block (a shovel for stone, a pickaxe for a
 * log). The tool the block needs is therefore looked up in the inventory as
 * well, so the bot digs with a tool that actually drops the block.
 * `value: null` means bare hands were judged sufficient.
 */
async function equipToolFor(facade: MinecraftFacade, ctx: ExecutionContext, target: BlockRef): Promise<ToolOutcome> {
  const families = BLOCK_TOOL[target.name] ?? [];
  const selected = await guardedOp(() => facade.selectToolFor(target.name), ctx, `Selecting a tool for ${target.name}`);
  if (selected.status === 'cancelled') return { status: 'cancelled' };
  if (selected.status === 'error') return { status: 'error', reason: selected.reason };

  const inInventory = families.length > 0 ? bestToolInInventory(facade, families) : null;
  const tool = pickTool(selected.value, inInventory, families);
  if (tool === null) return { status: 'ok', value: null };

  const equipped = await guardedOp(() => facade.equipItem(tool), ctx, `Equipping ${tool}`);
  if (equipped.status === 'cancelled') return { status: 'cancelled' };
  if (equipped.status === 'error') return { status: 'error', reason: equipped.reason };
  if (!equipped.value) {
    return { status: 'error', reason: `I don't have a ${tool} to mine ${target.name} with.` };
  }
  return { status: 'ok', value: tool };
}

/**
 * The tool to dig with. A tool in the inventory is one the bot certainly
 * owns, so it wins whenever it serves the block; the tool the facade offered
 * is used only when the inventory holds nothing that serves it.
 */
function pickTool(
  offered: string | null,
  inInventory: string | null,
  families: readonly string[],
): string | null {
  if (inInventory !== null) return inInventory;
  if (offered !== null && (families.length === 0 || families.some((f) => servesToolFamily(offered, f)))) {
    return offered;
  }
  return null;
}