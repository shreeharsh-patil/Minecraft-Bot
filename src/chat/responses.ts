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
    const line = this.buildLine(target ? `${target}, ` : '', message);
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
      // The drain never rejects, but the promise is caught anyway: a floating
      // rejection would take the whole process down.
      void this.drain().catch((error: unknown) => {
        this.logger.error('chat drain failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
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
          this.logger.error('chat emit failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (this.inFlight === next) this.inFlight = null;
          next.resolve();
        }
      }
    } finally {
      this.sending = false;
    }
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
  let current = 'Commands:';
  for (const command of COMMAND_SYNTAX) {
    const entry = `${prefix}${command.usage}`;
    const isFirst = current === 'Commands:';
    const candidate = isFirst ? `${current} ${entry}` : `${current}, ${entry}`;
    if (!isFirst && candidate.length > maxLength) {
      lines.push(`${current}.`);
      current = `Commands: ${entry}`;
      continue;
    }
    current = candidate;
  }
  lines.push(`${current}.`);
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