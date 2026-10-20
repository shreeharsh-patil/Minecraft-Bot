/** `look_at`: turn towards a position, optionally holding the gaze. */
import type { MinecraftFacade } from '../../types/facade.js';
import type { LookParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import type { Vec3Like } from '../../types/world.js';
import { clamp, failedResult, isCancellation } from '../internal/helpers.js';
import { sleep } from '../../utils/sleep.js';

/** Default gaze hold, and the maximum allowed. */
export const DEFAULT_LOOK_MS = 1_500;
export const MAX_LOOK_MS = 30_000;

export class LookAtSkill implements Skill<LookParams> {
  public readonly name: ActionType = 'look_at';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.NONE];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: LookParams, ctx: ExecutionContext): Promise<SkillResult> {
    const position = params.position as Vec3Like | undefined;
    if (
      typeof position !== 'object' ||
      position === null ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) {
      return failedResult('That is not a valid thing to look at.', 0);
    }
    // A cancelled action must never reach the world: the bot would still turn
    // its head at a target nobody wants any more.
    if (ctx.signal.aborted) {
      return { ok: false, detail: 'Cancelled before I started looking.', count: 0 };
    }

    const durationMs = clamp(params.durationMs ?? DEFAULT_LOOK_MS, 0, MAX_LOOK_MS);

    try {
      // Looking means standing still: the body stops, then the bot turns.
      this.facade.stopMoving();
      this.facade.lookAt(position, true);
      if (durationMs > 0) await sleep(durationMs, ctx.signal);
      return { ok: true, detail: 'Looking.', count: 0 };
    } catch (error) {
      if (isCancellation(error)) return { ok: false, detail: 'Stopped looking.', count: 0 };
      return failedResult('Could not look there.', 0);
    }
  }
}

export function createLookAtSkill(facade: MinecraftFacade): LookAtSkill {
  return new LookAtSkill(facade);
}