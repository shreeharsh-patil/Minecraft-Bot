/** Retry with exponential backoff and jitter. Abort-aware. */
import { AbortedError, sleep } from './sleep.js';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Return false to stop retrying immediately (e.g. a non-retryable status). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  random?: () => number;
}

export async function retry<T>(
  work: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const requestedAttempts = options.attempts ?? 3;
  // The attempt count has to be a finite integer: a fractional count breaks
  // the "is this the last attempt" check, and a non-finite count would either
  // retry forever or skip the loop entirely - which would reject with
  // `undefined` instead of the error the work actually failed with.
  const attempts = Number.isFinite(requestedAttempts) ? Math.max(1, Math.floor(requestedAttempts)) : 3;
  const base = options.baseDelayMs ?? 250;
  const max = options.maxDelayMs ?? 5_000;
  const rand = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Abort-aware: a cancelled signal must not start another attempt, and the
    // abort must not be hidden behind the error the work failed with.
    if (options.signal?.aborted) throw new AbortedError();
    try {
      return await work(attempt);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw new AbortedError();
      const isLast = attempt === attempts;
      if (isLast || options.shouldRetry?.(error, attempt) === false) break;
      // Full jitter avoids a thundering herd when several providers fail at once.
      const exponential = Math.min(max, base * 2 ** (attempt - 1));
      const delay = Math.round(exponential * (0.5 + rand() * 0.5));
      options.onRetry?.(error, attempt, delay);
      await sleep(delay, options.signal);
    }
  }
  throw lastError;
}