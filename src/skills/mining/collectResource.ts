/**
 * Collect N of a human-named resource ("oak logs", "cobblestone", "wood").
 *
 * Resolves the phrase to candidate block names and then reuses the shared
 * mining loop - there is deliberately no second mining implementation.
 */
import type { MinecraftFacade } from '../../types/facade.js';
import type { CollectParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import { describeError, failedResult, isCancellation, normaliseBlockName } from '../internal/helpers.js';
import { MAX_BLOCKS_PER_TASK, resolveResourceNames, runMining } from './shared.js';

export class CollectResourceSkill implements Skill<CollectParams> {
  public readonly name: ActionType = 'collect_resource';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.MINING];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: CollectParams, ctx: ExecutionContext): Promise<SkillResult> {
    const resource = normaliseBlockName(params.resource ?? '');
    if (resource.length === 0) {
      return failedResult('I need to know what to collect.', 0);
    }

    const names = resolveResourceNames(resource);
    if (names.length === 0) {
      return failedResult(`I don't know how to collect "${params.resource}".`, 0);
    }

    const requested = Math.floor(params.count);
    if (!Number.isFinite(requested) || requested <= 0) {
      return failedResult('I need a count of at least 1 to collect.', 0);
    }
    const target = Math.min(requested, MAX_BLOCKS_PER_TASK);
    const label = params.resource.replace(/[_-]+/g, ' ').trim();

    const where = typeof params.from === 'string' && params.from.trim().length > 0 ? ` from ${params.from.trim()}` : '';

    try {
      const run = await runMining(this.facade, ctx, {
        names,
        count: target,
        label: `${label}${where}`,
      });

      if (run.cancelled) {
        return {
          ok: false,
          detail: `Stopped collecting ${label} after ${run.mined}.`,
          count: run.mined,
          remaining: Math.max(0, target - run.mined),
        };
      }
      if (run.mined >= target) {
        return { ok: true, detail: `Collected ${run.mined} ${label}${where}.`, count: run.mined };
      }
      return {
        ok: false,
        detail: run.reason ?? `I only collected ${run.mined} of ${target} ${label}.`,
        count: run.mined,
        remaining: Math.max(0, target - run.mined),
      };
    } catch (error) {
      if (isCancellation(error)) {
        return { ok: false, detail: `Stopped collecting ${label}.`, count: 0, remaining: target };
      }
      return failedResult(`Collecting ${label} failed: ${describeError(error)}`, 0, target);
    }
  }
}

export function createCollectResourceSkill(facade: MinecraftFacade): CollectResourceSkill {
  return new CollectResourceSkill(facade);
}