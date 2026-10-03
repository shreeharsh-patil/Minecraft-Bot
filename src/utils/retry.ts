/** Retry with exponential backoff and jitter. Abort-aware. */
import { sleep } from './sleep.js';

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
  const attempts = Math.max(1, options.attempts ?? 3);
  const base = options.baseDelayMs ?? 250;
  const max = options.maxDelayMs ?? 5_000;
  const rand = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work(attempt);
    } catch (error) {
      lastError = error;
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