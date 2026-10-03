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
import type { Logger } from '../utils/logger.js';

/** Chat replies are sanitised and length-limited before sending. */
export class ChatResponder {
  private readonly logger: Logger;
  private readonly maxLength = 240;
  /** Minimum gap between outbound chat lines to avoid server spam flags. */
  private readonly minIntervalMs: number;
  private lastSentAt = 0;
  private queue: Array<{ text: string; resolve: () => void }> = [];
  private sending = false;

  constructor(logger: Logger, minIntervalMs = 400) {
    this.logger = logger.child({ component: 'responder' });
    this.minIntervalMs = minIntervalMs;
  }

  /**
   * Sends a message, sanitising it first.
   * Serialised so rapid replies never exceed the server rate limit.
   */
  async send(target: string, message: string): Promise<void> {
    const safe = safeChatReply(message, this.maxLength);
    if (safe.length === 0) return;

    return new Promise<void>((resolve) => {
      this.queue.push({ text: target ? `${target}, ${safe}` : safe, resolve });
      void this.drain();
    });
  }

  /** Bare message with no name prefix (for system-style notices). */
  async announce(message: string): Promise<void> {
    const safe = safeChatReply(message, this.maxLength);
    if (safe.length === 0) return;
    return new Promise<void>((resolve) => {
      this.queue.push({ text: safe, resolve });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) break;
        const elapsed = Date.now() - this.lastSentAt;
        if (elapsed < this.minIntervalMs) {
          await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
        }
        this.emit(next.text);
        this.lastSentAt = Date.now();
        next.resolve();
      }
    } finally {
      this.sending = false;
    }
  }

  /** Overridden by the bot to actually put the line in Minecraft chat. */
  emit: (text: string) => void = (text) => {
    this.logger.debug('chat out', { text });
  };

  /** Test helper: drop anything pending. */
  clear(): void {
    for (const item of this.queue) item.resolve();
    this.queue = [];
  }
}

// --- pure formatters -------------------------------------------------------

export function formatHelp(prefix: string): string {
  return [
    `Commands: ${prefix}come, ${prefix}goto x y z, ${prefix}follow <player>, ${prefix}stop, `,
    `${prefix}stay, ${prefix}guard <player>, ${prefix}inventory, ${prefix}status, ${prefix}help`,
  ].join(' ');
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
  providerCount: number;
}): string {
  const task =
    params.activeTasks.length === 0
      ? 'idle'
      : `${params.activeTasks.length} task(s): ${params.activeTasks
          .map((t) => t.type)
          .slice(0, 3)
          .join(', ')}`;
  return (
    `HP ${Math.round(params.health)}/${params.maxHealth}, food ${Math.round(params.food)}, ` +
    `${params.dimension} at ${Math.round(params.position.x)},${Math.round(params.position.y)},` +
    `${Math.round(params.position.z)}. ${task}. ${params.providerCount} AI provider(s) configured.`
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