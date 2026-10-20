/**
 * `stop`: halt all movement immediately.
 *
 * This is the in-plan stop - the planner's "stop" action. The `!stop`
 * command does NOT come through this skill: the chat listener cancels the
 * tasks, the plan and the AI itself (see `stopEverything` in src/index.ts)
 * and then calls the facade directly. A skill can only do the one thing a
 * skill can do: halt the body.
 */
import type { MinecraftFacade } from '../../types/facade.js';
import type { Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import { describeError, failedResult } from '../internal/helpers.js';

export class StopSkill implements Skill<Record<string, never>> {
  public readonly name: ActionType = 'stop';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.NONE];

  constructor(private readonly facade: MinecraftFacade) {}

  /** The stop action takes no parameters and has nothing to await. */
  public execute(): Promise<SkillResult> {
    try {
      this.facade.stopMoving();
      return Promise.resolve({ ok: true, detail: 'Stopped.', count: 0 });
    } catch (error) {
      return Promise.resolve(failedResult(`Could not stop: ${describeError(error)}`, 0));
    }
  }
}

export function createStopSkill(facade: MinecraftFacade): StopSkill {
  return new StopSkill(facade);
}