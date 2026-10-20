/**
 * Chat listener and command dispatcher.
 *
 * Command priority (highest first):
 *   1. `!stop`              - cancels everything instantly, always honoured
 *   2. deterministic `!`    - parsed locally, never touches an LLM
 *   3. unknown/malformed `!` - answered locally, never reaches the planner
 *   4. natural language     - routed to the AI planner
 *   5. plain chat           - routed to the AI planner as well, so it can
 *                              end up as a real action
 *
 * Everything is gated on authorization: only an authorized player ever
 * reaches the planner. Chat from an unlisted player is ignored outright, so
 * it can never become an instruction.
 */
import type { BotAction } from '../types/actions.js';
import type { MinecraftFacade } from '../types/facade.js';
import type { AuthorizationService } from '../safety/permissions.js';
import { sanitizeChatMessage, SECRET_REFUSAL } from '../safety/chatInjectionGuard.js';
import {
  parseInput,
  toAction,
  DETERMINISTIC_COMMANDS,
  LOCAL_COMMANDS,
  parseLocationName,
} from './commandParser.js';
import type { ChatResponder } from './responses.js';
import type { Logger } from '../utils/logger.js';
import type { MemoryStore } from '../types/memory.js';

export interface ChatMessage {
  username: string;
  message: string;
}

export type ChatRoute =
  | { kind: 'stop'; reason: string }
  | { kind: 'deterministic'; action: BotAction }
  | { kind: 'local'; name: string; args: string[] }
  | { kind: 'usage'; message: string }
  | { kind: 'ai'; text: string }
  | { kind: 'ignored'; reason: string };

export interface ChatListenerDeps {
  facade: MinecraftFacade;
  auth: AuthorizationService;
  responder: ChatResponder;
  memory: MemoryStore;
  prefix: string;
  logger: Logger;
  /** Executes a validated deterministic action. */
  runDeterministic: (owner: string, action: BotAction) => Promise<void>;
  /** Hands a natural-language request to the AI planner. */
  handleNaturalLanguage: (owner: string, text: string) => Promise<void>;
  /** Cancels every task/plan. Must be synchronous and immediate. */
  stopEverything: (reason: string) => void;
  /** Handles local commands that need memory/status (help, remember, home...). */
  handleLocal: (owner: string, name: string, args: string[]) => Promise<void>;
}

/**
 * Turns a parser error into a chat-friendly usage line: the parser reports
 * errors in lower case ("usage: !goto <x> <y> <z>"), the player reads a
 * sentence.
 */
function usageReply(error: string): string {
  const first = error.charAt(0);
  return first === '' ? error : `${first.toUpperCase()}${error.slice(1)}`;
}

export class ChatListener {
  private readonly deps: ChatListenerDeps;
  private readonly logger: Logger;

  constructor(deps: ChatListenerDeps) {
    this.deps = deps;
    this.logger = deps.logger.child({ component: 'chat' });
  }

  /** Classifies a chat line. No world access beyond the username, so testable. */
  route(message: ChatMessage): ChatRoute {
    const { prefix, auth } = this.deps;

    // Never treat the bot's own output as an instruction.
    if (message.username.toLowerCase() === this.deps.facade.username.toLowerCase()) {
      return { kind: 'ignored', reason: 'self' };
    }

    const parsed = parseInput(message.message, prefix);
    if (parsed.kind === 'empty') return { kind: 'ignored', reason: 'empty' };

    // `!stop` is highest priority. It can only ever reduce what the bot does,
    // so it is honoured for authorized players before other gating.
    if (parsed.kind === 'command' && parsed.command?.name === 'stop') {
      if (!auth.isAuthorized(message.username)) {
        return { kind: 'ignored', reason: 'not-authorized' };
      }
      return { kind: 'stop', reason: `${message.username} requested stop` };
    }

    const decision = auth.authorize({ username: message.username });
    if (!decision.allowed) {
      return {
        kind: 'ignored',
        reason: decision.reason === 'rate-limited' ? 'rate-limited' : 'not-authorized',
      };
    }

    if (parsed.kind === 'command' && parsed.command) {
      const { name, args } = parsed.command;
      if (LOCAL_COMMANDS.has(name)) return { kind: 'local', name, args };
      if (DETERMINISTIC_COMMANDS.has(name)) {
        const converted = toAction(name, args);
        if ('error' in converted) {
          // A malformed deterministic command is a usage error, not a task
          // for the planner: a typo such as `!goto 1 2` must never turn
          // into a world action.
          this.logger.debug('deterministic parse failed', { name, error: converted.error });
          return { kind: 'usage', message: usageReply(converted.error) };
        }
        return { kind: 'deterministic', action: converted };
      }
      // An unknown command name is answered by the local handler ("Unknown
      // command: X"), never handed to the planner as if it were a request.
      return { kind: 'local', name, args };
    }

    return { kind: 'ai', text: parsed.text };
  }
/** Entry point: route then dispatch. Never throws into the mineflayer event loop. */
  async handle(message: ChatMessage): Promise<void> {
    let decision: ChatRoute;
    try {
      decision = this.route(message);
    } catch (error) {
      this.logger.error('chat routing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    this.logger.debug('chat', {
      user: message.username,
      route: decision.kind,
      ...('reason' in decision ? { reason: decision.reason } : {}),
    });

    try {
      switch (decision.kind) {
        case 'ignored':
          return;

        case 'stop': {
          // Synchronous so `!stop` is instant even mid-pathfinding.
          this.deps.stopEverything(decision.reason);
          await this.deps.responder.send(message.username, 'Stopped.');
          return;
        }

        case 'local':
          await this.deps.handleLocal(message.username, decision.name, decision.args);
          return;

        case 'usage':
          // A plain usage error - no action, no planner, no world access.
          await this.deps.responder.send(message.username, decision.message);
          return;

        case 'deterministic':
          await this.deps.runDeterministic(message.username, decision.action);
          return;

        case 'ai': {
          const sanitized = sanitizeChatMessage(decision.text);
          if (sanitized.sensitive) {
            // Never let a chat message ask for credentials or host access.
            this.logger.warn('refused sensitive request', { user: message.username });
            this.deps.memory.noteFailure('ai', 'sensitive request refused');
            await this.deps.responder.send(message.username, SECRET_REFUSAL);
            return;
          }
          if (sanitized.suspicious) {
            this.logger.warn('possible prompt injection', {
              user: message.username,
              flags: sanitized.flags,
            });
          }
          this.deps.memory.noteConversation(message.username, sanitized.text);
          await this.deps.handleNaturalLanguage(message.username, sanitized.text);
          return;
        }

        default:
          return;
      }
    } catch (error) {
      // A failure in one command must never kill the chat listener.
      this.logger.error('chat handling failed', {
        user: message.username,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.deps.responder
        .send(message.username, 'Something went wrong handling that.')
        .catch(() => undefined);
    }
  }
}

export { parseLocationName };