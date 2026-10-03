import { BLOCK_TOOL, SOFT_BLOCKS } from '../../config/constants.js';
import type { BlockRef, MinecraftFacade } from '../../types/facade.js';
import type { ExecutionContext } from '../../types/task.js';
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
export const MAX_BLOCKS_PER_TASK = 512;
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
  const tried = new Set<string>();
  let mined = 0;
  let failures = 0;
  let cancelled = false;
  let reason: string | null = null;

  while (mined < options.count) {
    if (ctx.signal.aborted) {
      cancelled = true;
      break;
    }

    const target = pickNextBlock(facade, options.names, searchDistance, tried);
    if (!target) {
      // A specific failure ("no pickaxe") is more useful than "ran out".
      reason ??= `I ran out of ${options.label} within ${searchDistance} blocks.`;
      break;
    }
    tried.add(posKey(target.position));

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

/** Nearest untried block matching any candidate name. */
function pickNextBlock(
  facade: MinecraftFacade,
  names: readonly string[],
  searchDistance: number,
  tried: ReadonlySet<string>,
): BlockRef | null {
  let best: BlockRef | null = null;
  for (const name of names) {
    for (const candidate of facade.findBlocks(name, searchDistance, 16)) {
      if (tried.has(posKey(candidate.position))) continue;
      if (isDangerousBlock(candidate.name)) continue;
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
  if ((last === 'logs' || last === 'log') && words.length > 1) {
    return [`${words.slice(0, -1).join('_')}_log`];
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
 * Picks the right tool for a block via `selectToolFor` and equips it.
 * `value: null` means bare hands were judged sufficient.
 */
async function equipToolFor(facade: MinecraftFacade, ctx: ExecutionContext, target: BlockRef): Promise<ToolOutcome> {
  const selected = await guardedOp(() => facade.selectToolFor(target.name), ctx, `Selecting a tool for ${target.name}`);
  if (selected.status === 'cancelled') return { status: 'cancelled' };
  if (selected.status === 'error') return { status: 'error', reason: selected.reason };

  const tool = selected.value;
  if (tool === null) return { status: 'ok', value: null };

  const equipped = await guardedOp(() => facade.equipItem(tool), ctx, `Equipping ${tool}`);
  if (equipped.status === 'cancelled') return { status: 'cancelled' };
  if (equipped.status === 'error') return { status: 'error', reason: equipped.reason };
  if (!equipped.value) {
    return { status: 'error', reason: `I don't have a ${tool} to mine ${target.name} with.` };
  }
  return { status: 'ok', value: tool };
}