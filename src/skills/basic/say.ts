/** `say`: emit one bounded chat line. Used by planner answers and refusals. */
import type { MinecraftFacade } from '../../types/facade.js';
import type { SayParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import { safeChatReply } from '../../safety/chatInjectionGuard.js';
import { describeError, failedResult } from '../internal/helpers.js';

/**
 * chat() is fire-and-forget at the facade, so this skill can only fail if the
 * facade throws synchronously. The message still goes through the redaction
 * gate (safeChatReply) here: this skill talks straight to the facade, so it
 * never passes through the responder layer that would otherwise redact it.
 */
export class SaySkill implements Skill<SayParams> {
  public readonly name: ActionType = 'say';
  // Chat needs no exclusive body access: it may overlap with movement.
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.NONE];

  constructor(private readonly facade: MinecraftFacade) {}

  public execute(params: SayParams): Promise<SkillResult> {
    // The final gate before anything is echoed into Minecraft chat: a
    // model-composed reply can never carry a path or a credential into a
    // public channel.
    const message = safeChatReply(params.message);
    if (message.length === 0) {
      return Promise.resolve(failedResult('Nothing to say.', 0));
    }
    try {
      this.facade.chat(message);
      return Promise.resolve({ ok: true, detail: message, count: 0 });
    } catch (error) {
      return Promise.resolve(failedResult(`Could not send chat: ${describeError(error)}`, 0));
    }
  }
}

export function createSaySkill(facade: MinecraftFacade): SaySkill {
  return new SaySkill(facade);
}
