/** `say`: emit one bounded chat line. Used by planner answers and refusals. */
import type { MinecraftFacade } from '../../types/facade.js';
import type { SayParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import { safeChatReply } from '../../safety/chatInjectionGuard.js';
import { describeError, failedResult } from '../internal/helpers.js';

/**
 * The longest line this skill may put on the wire.
 *
 * The bot is created with `chatLengthLimit: 100` (src/bot/createBot.ts), and
 * mineflayer does not reject a longer line - it SPLITS it into several chat
 * packets. Both halves of that are bad here:
 *
 *  - this skill promises ONE bounded chat line, and a split turns a single
 *    answer into two or three lines of public chat;
 *  - a piece that starts with "/" is sent as a command packet (the protocol
 *    turns a leading slash into `chat_command`), so the server EXECUTES it.
 *    The validator only rejects a message whose FIRST character is a slash,
 *    which does not cover a line that is split.
 *
 * So the text is bounded to a single server line here, in the last place that
 * can still see it.
 */
export const MAX_CHAT_LINE_CHARS = 100;

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
    const message = safeChatReply(params.message, MAX_CHAT_LINE_CHARS);
    if (message.length === 0) {
      return Promise.resolve(failedResult('Nothing to say.', 0));
    }
    // Defence in depth: a line that starts with a slash is a server COMMAND,
    // not chat ("/op @a" would be executed by the server). The validator
    // rejects those too, but this is the last gate before the wire.
    if (message.startsWith('/') || message.startsWith('\\')) {
      return Promise.resolve(failedResult('That is a command, not something I can say.', 0));
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
