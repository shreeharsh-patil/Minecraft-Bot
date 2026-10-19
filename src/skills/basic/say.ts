/** `say`: emit one bounded chat line. Used by planner answers and refusals. */
import type { MinecraftFacade } from '../../types/facade.js';
import type { SayParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import { describeError, failedResult } from '../internal/helpers.js';

/**
 * chat() is fire-and-forget at the facade, so this skill can only fail if the
 * facade throws synchronously. Rate limiting + redaction happen in the
 * responder layer; the message text has already passed the validator.
 */
export class SaySkill implements Skill<SayParams> {
  public readonly name: ActionType = 'say';
  // Chat needs no exclusive body access: it may overlap with movement.
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.NONE];

  constructor(private readonly facade: MinecraftFacade) {}

  public execute(params: SayParams): Promise<SkillResult> {
    try {
      this.facade.chat(params.message);
      return Promise.resolve({ ok: true, detail: params.message, count: 0 });
    } catch (error) {
      return Promise.resolve(failedResult(`Could not send chat: ${describeError(error)}`, 0));
    }
  }
}

export function createSaySkill(facade: MinecraftFacade): SaySkill {
  return new SaySkill(facade);
}
