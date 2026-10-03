/** `stop`: halt all movement immediately. Also the cleanup path for `!stop`. */
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