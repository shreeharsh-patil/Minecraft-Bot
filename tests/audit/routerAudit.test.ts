/**
 * Router audit: error classification and the attempt deadline.
 *
 * Three defects that made the fallback chain misbehave:
 *
 *  - an abort that did NOT come from the caller (a provider that aborts on
 *    its own) was treated as a terminal "the user pressed !stop" and killed
 *    the whole chain, even though the file documents that *only* a caller
 *    abort stops the chain;
 *  - a user abort that surfaced with any other error kind (the provider's
 *    own timeout racing the cancellation) was charged to the provider's
 *    failure counters - which opens the circuit breaker of a healthy
 *    provider - and was swallowed as an outage instead of being propagated
 *    as an abort;
 *  - the router trusted the provider to honour `timeoutMs` completely: a
 *    provider that never answered ate the whole deadline (or hung the bot
 *    for good) and the fallback chain never got its turn.
 */
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/types/provider.js';
import type { AiProvider, CompletionRequest, CompletionResult, ProviderName } from '../../src/types/provider.js';
import { AIRouter, AIUnavailableError } from '../../src/ai/router.js';
import type { AIRouterOptions } from '../../src/ai/router.js';

/** A scriptable provider: no HTTP, deterministic outcomes. */
class FakeProvider implements AiProvider {
  public readonly name: ProviderName;
  public readonly model: string;
  public calls = 0;

  private readonly handler: (request: CompletionRequest) => Promise<CompletionResult>;

  constructor(name: ProviderName, handler: (request: CompletionRequest) => Promise<CompletionResult>) {
    this.name = name;
    this.model = `${name}-model`;
    this.handler = handler;
  }

  public isAvailable(): boolean {
    return true;
  }

  public healthCheck(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls += 1;
    return this.handler(request);
  }

  public dispose(): void {
    /* nothing to release */
  }
}

/** The error shape a runtime uses when a request is cancelled. */
function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function ok(text = '{"actions":[{"type":"stop"}]}'): Promise<CompletionResult> {
  return Promise.resolve({ text, latencyMs: 5, model: 'fake' });
}

function request(timeoutMs = 5_000, signal?: AbortSignal): CompletionRequest {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    jsonMode: true,
    timeoutMs,
    ...(signal ? { signal } : {}),
  };
}

function makeRouter(overrides: Partial<AIRouterOptions> = {}): AIRouter {
  return new AIRouter({
    requestTimeoutMs: 5_000,
    failureThreshold: 3,
    cooldownMs: 1_000,
    ...overrides,
  });
}

describe('router - only a caller abort is terminal', () => {
  it('falls through to the next provider when a provider aborts on its own', async () => {
    const router = makeRouter();
    // The provider aborts by itself (its own timeout, a dropped socket) -
    // nobody cancelled the request.
    const selfAborting = new FakeProvider('openai', () => Promise.reject(abortError()));
    const working = new FakeProvider('groq', () => ok());
    router.pool.register(selfAborting, 'fast');
    router.pool.register(working, 'fast');

    const result = await router.complete(request(), 'fast');

    expect(result.provider).toBe('groq');
    expect(result.attempts).toBe(2);
    expect(working.calls).toBe(1);
    // It is the provider's fault, so it is charged like any other failure.
    expect(router.pool.statsFor('openai')?.failures).toBe(1);
  });

  it('falls through to the next provider when a provider reports an aborted error', async () => {
    const router = makeRouter();
    const selfAborting = new FakeProvider('openai', () =>
      Promise.reject(new ProviderError('openai', 'aborted', 'openai: request aborted', { retryable: false })),
    );
    const working = new FakeProvider('groq', () => ok());
    router.pool.register(selfAborting, 'fast');
    router.pool.register(working, 'fast');

    const result = await router.complete(request(), 'fast');

    expect(result.provider).toBe('groq');
    expect(working.calls).toBe(1);
  });

  it('does not charge a cancelled request to the provider when it surfaces as a timeout', async () => {
    const router = makeRouter();
    // The provider's own timeout fired just before the cancellation, so the
    // provider reports a timeout although the caller cancelled the request.
    const slow = new FakeProvider(
      'openai',
      (req) =>
        new Promise<CompletionResult>((_resolve, reject) => {
          req.signal?.addEventListener(
            'abort',
            () => {
              reject(new ProviderError('openai', 'timeout', 'openai: request exceeded 5000ms', { retryable: true }));
            },
            { once: true },
          );
        }),
    );
    router.pool.register(slow, 'fast');

    const controller = new AbortController();
    const promise = router.complete(request(5_000, controller.signal), 'fast');
    setTimeout(() => controller.abort(), 10);

    // The cancellation is propagated as an abort, not as an outage.
    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
    await expect(promise).rejects.not.toBeInstanceOf(AIUnavailableError);

    // And it is not charged to the provider: the user pressed !stop.
    expect(router.pool.statsFor('openai')?.failures).toBe(0);
    expect(router.pool.statsFor('openai')?.consecutiveFailures).toBe(0);
    expect(router.pool.circuitState('openai')).toBe('closed');
  });

  it('still stops the chain and does not charge the provider when the caller aborts', async () => {
    const router = makeRouter();
    const hanging = new FakeProvider(
      'openai',
      (req) =>
        new Promise<CompletionResult>((_resolve, reject) => {
          req.signal?.addEventListener(
            'abort',
            () => {
              reject(abortError());
            },
            { once: true },
          );
        }),
    );
    const working = new FakeProvider('groq', () => ok());
    router.pool.register(hanging, 'fast');
    router.pool.register(working, 'fast');

    const controller = new AbortController();
    const promise = router.complete(request(5_000, controller.signal), 'fast');
    setTimeout(() => controller.abort(), 10);

    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
    // The fallback is not burned on a cancelled request.
    expect(working.calls).toBe(0);
    expect(router.pool.statsFor('openai')?.failures).toBe(0);
    expect(router.pool.circuitState('openai')).toBe('closed');
  });
});

describe('router - the router enforces the attempt deadline itself', () => {
  it('abandons an attempt that outlives its budget so the fallback still runs', async () => {
    const router = makeRouter({ requestTimeoutMs: 300 });
    // A provider that never answers and ignores its own timeout.
    const stuck = new FakeProvider(
      'openai',
      () => new Promise<CompletionResult>(() => undefined),
    );
    const working = new FakeProvider('groq', () => ok());
    router.pool.register(stuck, 'fast');
    router.pool.register(working, 'fast');

    const started = Date.now();
    const outcome = await Promise.race([
      router.complete(request(300), 'fast').then(
        (result) => ({ kind: 'answered' as const, result }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      ),
      new Promise<{ kind: 'hung' }>((resolve) => {
        const timer = setTimeout(() => resolve({ kind: 'hung' }), 2_000);
        timer.unref();
      }),
    ]);
    const elapsed = Date.now() - started;

    expect(outcome.kind).not.toBe('hung');
    expect(outcome.kind).toBe('answered');
    // The chain stayed inside the deadline instead of eating it.
    expect(elapsed).toBeLessThan(300);
    expect(working.calls).toBe(1);
    // The provider that never answered is charged with a timeout.
    expect(router.pool.statsFor('openai')?.timeouts).toBe(1);
  });

  it('gives the fallback a turn when the primary overruns the whole deadline', async () => {
    const router = makeRouter({ requestTimeoutMs: 400 });
    // The provider answers, but only long after its budget is gone.
    const slow = new FakeProvider(
      'openai',
      (req) =>
        new Promise<CompletionResult>((resolve) => {
          const timer = setTimeout(() => resolve({ text: '{}', latencyMs: 10_000, model: 'fake' }), 10_000);
          timer.unref();
          req.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
        }),
    );
    const working = new FakeProvider('groq', () => ok());
    router.pool.register(slow, 'fast');
    router.pool.register(working, 'fast');

    const started = Date.now();
    const result = await router.complete(request(400), 'fast');
    const elapsed = Date.now() - started;

    expect(result.provider).toBe('groq');
    expect(result.attempts).toBe(2);
    expect(elapsed).toBeLessThan(400);
  });
});
