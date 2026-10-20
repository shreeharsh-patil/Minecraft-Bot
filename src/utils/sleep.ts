/** Cancellable sleep helpers. All timing in the bot funnels through these. */

export class AbortedError extends Error {
  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'AbortedError';
  }
}

/** Sleeps for `ms`, rejecting immediately if the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AbortedError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    // The timer stays REFERENCED on purpose. An unref'd timer does not keep
    // the event loop alive, so a process that was only waiting on a sleep (the
    // reconnect backoff is exactly that) exited silently with code 0 - the
    // bot simply never came back after a server restart.
    function onAbort(): void {
      clearTimeout(timer);
      reject(new AbortedError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A promise plus its resolve/reject handles - avoids `let` gymnastics. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Polls `predicate` until it is true or the deadline passes.
 * Used instead of long fixed sleeps so behaviour stays responsive to `!stop`.
 */
export async function waitUntil(
  predicate: () => boolean,
  opts: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal; description?: string },
): Promise<void> {
  const interval = opts.intervalMs ?? 100;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new AbortedError();
    if (predicate()) return;
    await sleep(interval, opts.signal);
  }
  throw new Error(opts.description ?? 'Timed out waiting for condition');
}

/**
 * Promise.race with a timeout, but the timer is always cleared so a late
 * response cannot hold a handle open.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  description = 'Operation',
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new AbortedError();
  const timeout = createDeferred<never>();
  const timer = setTimeout(() => {
    timeout.reject(new Error(`${description} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  // Referenced on purpose: if the awaited work never settles and nothing else
  // holds the event loop, an unref'd timer would let the process exit silently
  // instead of reporting the timeout.
  const onAbort = (): void => timeout.reject(new AbortedError());
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await Promise.race([work, timeout.promise]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}