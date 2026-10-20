/** `wait`: idle for a bounded time, staying responsive to `!stop`. */
import type { MinecraftFacade } from '../../types/facade.js';
import type { WaitParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import { clamp, failedResult, isCancellation } from '../internal/helpers.js';
import { sleep } from '../../utils/sleep.js';

/** Never sleep longer than this in one action. */
export const MAX_WAIT_MS = 300_000;

export class WaitSkill implements Skill<WaitParams> {
  public readonly name: ActionType = 'wait';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.NONE];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: WaitParams, ctx: ExecutionContext): Promise<SkillResult> {
    const durationMs = clamp(Math.floor(params.durationMs ?? 0), 0, MAX_WAIT_MS);
    if (durationMs === 0) return { ok: true, detail: 'No need to wait.', count: 0 };

    try {
      // Idle means idle: the body stops before the wait, and the wait is what
      // keeps it there. The facade call is inside the try, so a facade that
      // fails comes back as a typed result instead of a thrown error.
      this.facade.stopMoving();
      await sleep(durationMs, ctx.signal);
      return { ok: true, detail: `Waited ${Math.round(durationMs / 1000)}s.`, count: 0 };
    } catch (error) {
      if (isCancellation(error)) return { ok: false, detail: 'Stopped waiting.', count: 0 };
      return failedResult(`Waiting failed: ${String(error)}`, 0);
    }
  }
}

export function createWaitSkill(facade: MinecraftFacade): WaitSkill {
  return new WaitSkill(facade);
}