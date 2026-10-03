/**
 * Reconnection with bounded exponential backoff and jitter.
 *
 * Deliberately finite: MAX_RECONNECT_ATTEMPTS caps the loop so a permanently
 * dead server does not produce an infinite reconnect storm. Certain failures
 * (auth problems, banned accounts) are never retried.
 */
import { sleep } from '../utils/sleep.js';
import type { Logger } from '../utils/logger.js';

/** Kicks that will never succeed on retry. */
const FATAL_PATTERNS: readonly RegExp[] = [
  /you are not whitelisted/i,
  /whitelist/i,
  /banned/i,
  /ban\b/i,
  /authentication/i,
  /invalid session/i,
  /outdated server/i,
  /multiplayer.*disconnect/i,
  /server is full/i,
];

export interface ReconnectPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random?: () => number;
}

export interface ReconnectContext {
  logger: Logger;
  /** Produces a fresh bot. Injected so this is testable without a server. */
  connect: () => Promise<void>;
  policy: ReconnectPolicy;
  /** Called after a successful reconnect. */
  onReconnected?: () => void | Promise<void>;
  /** Called before each delay so the bot can announce/log. */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
  signal?: AbortSignal;
}

export type ReconnectOutcome = 'connected' | 'exhausted' | 'fatal' | 'aborted';

/** True when the kick reason is permanent and retrying is pointless. */
export function isFatalDisconnect(reason: string): boolean {
  return FATAL_PATTERNS.some((pattern) => pattern.test(reason));
}

/**
 * Attempts to reconnect with backoff. Returns how the attempt ended rather than
 * throwing, so the caller can decide whether to keep running.
 */
export async function reconnect(ctx: ReconnectContext): Promise<ReconnectOutcome> {
  const { logger, policy, connect } = ctx;
  const rand = policy.random ?? Math.random;

  if (policy.maxAttempts <= 0) {
    logger.warn('reconnect disabled (MAX_RECONNECT_ATTEMPTS=0)');
    return 'exhausted';
  }

  let lastReason = 'unknown';

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (ctx.signal?.aborted) return 'aborted';

    // Full jitter keeps a fleet of bots from stampeding a restarting server.
    const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
    const delay = Math.round(exponential * (0.5 + rand() * 0.5));

    logger.info('reconnecting', { attempt, maxAttempts: policy.maxAttempts, delayMs: delay });
    ctx.onRetry?.(attempt, delay, lastReason);

    try {
      await sleep(delay, ctx.signal);
      if (ctx.signal?.aborted) return 'aborted';

      await connect();
      logger.info('reconnected', { attempt });
      await ctx.onReconnected?.();
      return 'connected';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      lastReason = reason;

      if (isFatalDisconnect(reason)) {
        logger.error('fatal disconnect - not retrying', { reason, attempt });
        return 'fatal';
      }
      logger.warn('reconnect attempt failed', { attempt, reason });
    }
  }

  logger.error('reconnect attempts exhausted', {
    maxAttempts: policy.maxAttempts,
    lastReason,
  });
  return 'exhausted';
}

/** Default policy derived from config values. */
export function policyFrom(
  maxAttempts: number,
  baseDelayMs: number,
  maxDelayMs = 60_000,
): ReconnectPolicy {
  return { maxAttempts, baseDelayMs, maxDelayMs };
}