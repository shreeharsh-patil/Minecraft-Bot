/**
 * Chat message formatting.
 *
 * Every string that can reach Minecraft chat is built here so that
 * redaction, length limiting and rate limiting are applied in one place.
 */
import type { ItemSummary } from '../types/world.js';
import type { TaskRecord } from '../types/task.js';
import type { ProviderStats } from '../types/provider.js';
import { safeChatReply } from '../safety/chatInjectionGuard.js';
import { COMMAND_SYNTAX } from './commandParser.js';
import type { Logger } from '../utils/logger.js';

/**
 * A Minecraft username is at most 16 characters (`[A-Za-z0-9_]{1,16}`), so a
 * longer "name" is not a name - it is junk that would eat the length budget
 * of the reply it prefixes.
 */
const MAX_NAME_LENGTH = 16;

/** One outbound chat line, waiting for its turn in the send queue. */
interface QueuedLine {
  /** The exact line that goes into Minecraft chat. */
  text: string;
  /** Releases the sender once the line was sent (or dropped). */
  resolve: () => void;
}

/** Chat replies are sanitised and length-limited before sending. */
export class ChatResponder {
  private readonly logger: Logger;
  /**
   * Vanilla servers reject a chat line longer than 256 characters ("Chat
   * message length exceeded") and disconnect the client, so the *whole* line
   * - name prefix included - has to fit into that budget.
   */
  private readonly maxLength = 256;
  /** Minimum gap between outbound chat lines to avoid server spam flags. */
  private readonly minIntervalMs: number;
  private lastSentAt = 0;
  private queue: QueuedLine[] = [];
  private sending = false;
  /** The line currently being emitted, so `clear()` can cancel it. */
  private inFlight: QueuedLine | null = null;
  /** Set by `clear()`: this responder is closed and emits nothing more. */
  private closed = false;

  constructor(logger: Logger, minIntervalMs = 400) {
    this.logger = logger.child({ component: 'responder' });
    this.minIntervalMs = minIntervalMs;
  }

  /**
   * Sends a message, sanitising it first.
   * Serialised so rapid replies never exceed the server rate limit.
   */
  async send(target: string, message: string): Promise<void> {
    const line = this.buildLine(this.namePrefix(target), message);
    if (line === null) return;
    await this.enqueue(line);
  }

  /** Bare message with no name prefix (for system-style notices). */
  async announce(message: string): Promise<void> {
    const line = this.buildLine('', message);
    if (line === null) return;
    await this.enqueue(line);
  }

  /**
   * The `"Name, "` prefix of a reply.
   *
   * The name goes through the same redaction gate as the message: it is a
   * string that reaches Minecraft chat, and a control character in it would
   * split the line into two (the newline the server never sees as one
   * message) while the length budget is charged for a single line.
   */
  private namePrefix(target: string): string {
    if (!target) return '';
    const name = safeChatReply(target, MAX_NAME_LENGTH);
    return name === '' ? '' : `${name}, `;
  }

  /**
   * Builds one server-legal chat line.
   *
   * The name prefix is part of the line the server sees, so it is charged
   * against the length budget: the body is truncated to whatever is left.
   * Returns null when there is nothing worth sending.
   */
  private buildLine(prefix: string, message: string): string | null {
    const budget = Math.max(1, this.maxLength - prefix.length);
    const body = safeChatReply(message, budget);
    if (body.length === 0) return null;
    const line = `${prefix}${body}`;
    // Belt and braces: never hand the server a line it would reject.
    return line.length <= this.maxLength ? line : `${line.slice(0, this.maxLength - 1)}…`;
  }

  /** Queues a line and lets the drain loop send it. */
  private enqueue(text: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ text, resolve });
      // The drain must never reject, but the promise is caught anyway: a
      // floating rejection would take the whole process down.
      void this.drain().catch((error: unknown) => {
        this.reportFailure('chat drain failed', error);
      });
    });
  }

  /**
   * Reports a failure without ever throwing.
   *
   * The log sink is the last thing that may go wrong, and it must not take
   * the send queue with it: a logger that throws would otherwise abort the
   * drain and leave every waiting sender on a promise that never settles.
   */
  private reportFailure(message: string, error: unknown): void {
    try {
      this.logger.error(message, {
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Nothing left to do: the failure is already being handled.
    }
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) break;
        this.inFlight = next;
        try {
          const elapsed = Date.now() - this.lastSentAt;
          if (elapsed < this.minIntervalMs) {
            await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
          }
          // `clear()` may have cancelled this line while we were waiting.
          if (this.closed || this.inFlight !== next) continue;
          this.emit(next.text);
          this.lastSentAt = Date.now();
        } catch (error) {
          // A failed send must never strand the sender or kill the process.
          this.reportFailure('chat emit failed', error);
        } finally {
          if (this.inFlight === next) this.inFlight = null;
          next.resolve();
        }
      }
    } finally {
      this.sending = false;
      // A drain that gives up early must not leave the senders that are
      // still queued on a promise that will never settle: they are released
      // like `clear()` releases them.
      this.releaseQueued();
    }
  }

  /** Releases every sender that is still waiting in the queue. */
  private releaseQueued(): void {
    const pending = [...this.queue];
    this.queue = [];
    for (const item of pending) item.resolve();
  }

  /** Overridden by the bot to actually put the line in Minecraft chat. */
  emit: (text: string) => void = (text) => {
    this.logger.debug('chat out', { text });
  };

  /**
   * Closes the responder: everything still queued is dropped, the line that
   * is currently being emitted is cancelled, and nothing is emitted after
   * this point (used when a session is torn down). The waiting senders are
   * released, so nobody is left hanging on a promise that will never settle.
   */
  clear(): void {
    this.closed = true;
    const pending = this.inFlight ? [...this.queue, this.inFlight] : [...this.queue];
    this.queue = [];
    this.inFlight = null;
    for (const item of pending) item.resolve();
  }
}

// --- pure formatters -------------------------------------------------------

/**
 * Packs the command list into as few chat lines as possible, each within
 * `maxLength`. Derived from `COMMAND_SYNTAX`, so a newly added command can never
 * be missing from help - and can never silently push the tail of the list past
 * the chat line limit.
 */
export function formatHelp(prefix: string, maxLength = 190): string[] {
  const lines: string[] = [];
  const header = 'Commands: ';
  let current = '';
  for (const command of COMMAND_SYNTAX) {
    const entry = `${prefix}${command.usage}`;
    // Every line ends with a '.', so the dot has to fit into the budget too.
    const candidate = current === '' ? `${header}${entry}` : `${current}, ${entry}`;
    if (candidate.length + 1 <= maxLength) {
      current = candidate;
      continue;
    }
    if (current !== '') {
      lines.push(`${current}.`);
      current = '';
    }
    // The command gets a line of its own. When it does not fit under the
    // header the header goes: a command that is never shown is worse than a
    // line without the header. A command that is too long even on its own is
    // truncated - never dropped, so the help stays complete.
    const own = `${header}${entry}`;
    current =
      own.length + 1 <= maxLength
        ? own
        : entry.slice(0, Math.max(0, maxLength - 1)).trimEnd();
  }
  if (current !== '') lines.push(`${current}.`);
  return lines;
}

export function formatInventory(items: ItemSummary[], held: string | null): string {
  if (items.length === 0) return 'My inventory is empty.';
  const parts = items.slice(0, 12).map((i) => `${i.count}x ${i.name.replace(/_/g, ' ')}`);
  const suffix = items.length > 12 ? ` (+${items.length - 12} more)` : '';
  return `Holding ${parts.join(', ')}${suffix}. In hand: ${held ?? 'nothing'}.`;
}

export function formatStatus(params: {
  username: string;
  health: number;
  maxHealth: number;
  food: number;
  dimension: string;
  position: { x: number; y: number; z: number };
  activeTasks: TaskRecord[];
  /** Human-readable "brain" description from the AI manager. */
  brain: string;
  /** Commands still allowed in the current rate-limit window, if known. */
  remainingCommands?: number;
}): string {
  const task =
    params.activeTasks.length === 0
      ? 'idle'
      : `${params.activeTasks.length} task(s): ${params.activeTasks
          .map((t) => t.type)
          .slice(0, 3)
          .join(', ')}`;
  const quota =
    params.remainingCommands === undefined ? '' : ` ${params.remainingCommands} cmd left.`;
  return (
    `HP ${Math.round(params.health)}/${params.maxHealth}, food ${Math.round(params.food)}, ` +
    `${params.dimension} at ${Math.round(params.position.x)},${Math.round(params.position.y)},` +
    `${Math.round(params.position.z)}. ${task}.${quota} ${params.brain}`
  );
}

export function formatProviders(stats: ProviderStats[]): string {
  if (stats.length === 0) return 'No AI providers configured.';
  return stats
    .map((s) => {
      const state = s.circuit.state === 'closed' ? 'ok' : s.circuit.state;
      const latency = s.avgLatencyMs > 0 ? `${Math.round(s.avgLatencyMs)}ms` : '-';
      return `${s.name}: ${state} ${latency} (${s.successes}/${s.requests})`;
    })
    .join(' | ');
}

export function formatResult(action: string, ok: boolean, detail?: string): string {
  const status = ok ? 'done' : `could not (${detail ?? 'unknown reason'})`;
  return `${action.replace(/_/g, ' ')} ${status}.`;
}