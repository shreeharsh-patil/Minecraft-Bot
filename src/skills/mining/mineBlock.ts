/**
 * Mine N blocks of a specific type.
 *
 * All of the real work lives in `runMining` (shared with `collectResource`).
 * This skill owns validation, clamping to `MAX_BLOCKS_PER_TASK`, and reporting.
 */
import type { MinecraftFacade } from '../../types/facade.js';
import type { MineParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import { AntiGriefRules } from '../../safety/antiGrief.js';
import { BLOCK_TOOL, SOFT_BLOCKS } from '../../config/constants.js';
import { describeError, failedResult, isCancellation, normaliseBlockName } from '../internal/helpers.js';
import { humaniseBlockName, MAX_BLOCKS_PER_TASK, resolveResourceNames, runMining } from './shared.js';

/** Does this name already name a block the bot knows how to mine? */
function isKnownBlock(name: string): boolean {
  return BLOCK_TOOL[name] !== undefined || SOFT_BLOCKS.has(name);
}

export class MineBlockSkill implements Skill<MineParams> {
  public readonly name: ActionType = 'mine_block';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.MINING];

  constructor(
    private readonly facade: MinecraftFacade,
    private readonly rules: AntiGriefRules = new AntiGriefRules(),
  ) {}

  public async execute(params: MineParams, ctx: ExecutionContext): Promise<SkillResult> {
    const blockName = normaliseBlockName(params.blockName ?? '');
    if (blockName.length === 0) {
      return failedResult('I need to know which block to mine.', 0);
    }

    // The request may name the block in words ("oak logs", "iron") instead of
    // by its block id, so the phrase is resolved to real block names first.
    // A name that already names a block the bot knows is mined as it is.
    const names = isKnownBlock(blockName) ? [blockName] : resolveResourceNames(blockName);
    if (names.length === 0) {
      return failedResult(`I don't know how to mine "${params.blockName}".`, 0);
    }

    const requested = Math.floor(params.count);
    if (!Number.isFinite(requested) || requested <= 0) {
      return failedResult('I need a count of at least 1 block to mine.', 0);
    }
    // Hard safety clamp: the model can never ask for an unbounded amount.
    const target = Math.min(requested, MAX_BLOCKS_PER_TASK);
    const label = humaniseBlockName(blockName);

    try {
      const run = await runMining(this.facade, ctx, {
        names,
        count: target,
        label,
        rules: this.rules,
      });

      if (run.cancelled) {
        return {
          ok: false,
          detail: `Stopped mining ${label} after ${run.mined}.`,
          count: run.mined,
          remaining: Math.max(0, target - run.mined),
        };
      }
      if (run.mined >= target) {
        return { ok: true, detail: `Mined ${run.mined} ${label}.`, count: run.mined };
      }
      return {
        ok: false,
        detail: run.reason ?? `I only mined ${run.mined} of ${target} ${label}.`,
        count: run.mined,
        remaining: Math.max(0, target - run.mined),
      };
    } catch (error) {
      if (isCancellation(error)) {
        return { ok: false, detail: `Stopped mining ${label}.`, count: 0, remaining: target };
      }
      return failedResult(`Mining ${label} failed: ${describeError(error)}`, 0, target);
    }
  }
}

export function createMineBlockSkill(facade: MinecraftFacade, rules?: AntiGriefRules): MineBlockSkill {
  return new MineBlockSkill(facade, rules);
}
