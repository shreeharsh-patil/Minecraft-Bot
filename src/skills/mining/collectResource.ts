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
import { AntiGriefRules } from '../../safety/antiGrief.js';
import { describeError, failedResult, isCancellation, normaliseBlockName } from '../internal/helpers.js';
import { MAX_BLOCKS_PER_TASK, humaniseBlockName, resolveResourceNames, runMining } from './shared.js';

/** Location names that mean "around here". */
const HERE_LOCATIONS: ReadonlySet<string> = new Set([
  'nearest',
  'here',
  'around',
  'current',
  'around here',
  'right here',
  'near here',
  'nearby',
]);

/**
 * The location as a phrase, the way a person says it.
 *
 * The validator canonicalises a location ("the mine" -> "the_mine"), so the
 * underscores are turned back into spaces: the bot has to answer with the
 * words the player used, and it has to recognise "around here" as the place
 * the player is standing in.
 */
function locationPhrase(location: string): string {
  return location.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export class CollectResourceSkill implements Skill<CollectParams> {
  public readonly name: ActionType = 'collect_resource';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.MINING];

  constructor(
    private readonly facade: MinecraftFacade,
    private readonly rules: AntiGriefRules = new AntiGriefRules(),
  ) {}

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
    const label = humaniseBlockName(resource);

    // A named location ("from the mine") can only be honoured if the bot
    // knows where that is. It does not - so say so instead of mining the
    // nearest ore anywhere and then claiming it came from there. The
    // locations that mean "around here" are the ones the bot does know.
    const from = typeof params.from === 'string' ? locationPhrase(params.from) : '';
    if (from.length > 0 && !HERE_LOCATIONS.has(from)) {
      return failedResult(`I don't know where "${from}" is.`, 0);
    }
    const where = from.length > 0 ? ` from ${from}` : '';

    try {
      const run = await runMining(this.facade, ctx, {
        names,
        count: target,
        label: `${label}${where}`,
        rules: this.rules,
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
      // The reason says why the run stopped, the count says how much of the
      // request it got. Only this line reaches the player, so without the
      // count a partly finished collection reads like a total failure.
      const reason = run.reason ?? `I only collected ${run.mined} of ${target} ${label}.`;
      return {
        ok: false,
        detail: run.mined > 0 ? `${reason} I collected ${run.mined} of ${target}.` : reason,
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

export function createCollectResourceSkill(
  facade: MinecraftFacade,
  rules?: AntiGriefRules,
): CollectResourceSkill {
  return new CollectResourceSkill(facade, rules);
}
