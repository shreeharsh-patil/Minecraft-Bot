/**
 * Router resilience.
 *
 * Three failure modes that made the bot misbehave in production:
 *  - the fallback provider was starved of time and always timed out;
 *  - a user-initiated `!stop` was charged to the provider and opened its
 *    circuit breaker;
 *  - a provider with a dead key kept being selected first because nobody
 *    ever called `healthCheck()`.
 */
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/types/provider.js';
import type { AiProvider, CompletionRequest, CompletionResult, ProviderName } from '../../src/types/provider.js';
import { AIRouter } from '../../src/ai/router.js';

type Health = boolean | 'never';

/** A scriptable provider: no HTTP, deterministic outcomes. */
class FakeProvider implements AiProvider {
  public readonly name: ProviderName;
  public readonly model: string;
  public calls = 0;
  public healthChecks = 0;

  private readonly handler: (request: CompletionRequest) => Promise<CompletionResult>;
  private readonly health: Health;
  private readonly available: boolean;

  constructor(
    name: ProviderName,
    handler: (request: CompletionRequest) => Promise<CompletionResult>,
    options: { health?: Health; available?: boolean } = {},
  ) {
    this.name = name;
    this.model = `${name}-model`;
    this.handler = handler;
    this.health = options.health ?? true;
    this.available = options.available ?? true;
  }

  public isAvailable(): boolean {
    return this.available;
  }

  public async healthCheck(): Promise<boolean> {
    this.healthChecks += 1;
    if (this.health === 'never') {
      // A probe that never settles: the request path must not wait for it.
      return new Promise<boolean>(() => undefined);
    }
    return this.health;
  }

  public complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls += 1;
    return this.handler(request);
  }

  public dispose(): void {
    /* nothing to release */
  }
}

/**
 * Answers after `delayMs`, like a slow but healthy provider.
 * It honours the attempt deadline exactly like a real adapter would.
 */
function slowOk(delayMs: number): (request: CompletionRequest) => Promise<CompletionResult> {
  return async (req: CompletionRequest): Promise<CompletionResult> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (delayMs > req.timeoutMs) {
      throw new ProviderError('groq', 'timeout', 'groq: timed out', { retryable: true });
    }
    return { text: '{"actions":[{"type":"stop"}]}', latencyMs: delayMs, model: 'fake' };
  };
}

/** Never answers on its own: it only times out at the attempt deadline. */
function hang(request: CompletionRequest): Promise<CompletionResult> {
  return new Promise<CompletionResult>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProviderError('openai', 'timeout', 'openai: timed out', { retryable: true }));
    }, request.timeoutMs);
    timer.unref();
    request.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      },
      { once: true },
    );
  });
}

function request(timeoutMs: number, signal?: AbortSignal): CompletionRequest {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    jsonMode: true,
    timeoutMs,
    ...(signal ? { signal } : {}),
  };
}

function makeRouter(overrides: { requestTimeoutMs?: number; failureThreshold?: number } = {}): AIRouter {
  return new AIRouter({
    requestTimeoutMs: overrides.requestTimeoutMs ?? 1_000,
    failureThreshold: overrides.failureThreshold ?? 3,
    cooldownMs: 1_000,
  });
}

describe('router - fair attempt budgets', () => {
  it('gives the fallback provider a fair share of the deadline when the primary hangs', async () => {
    const router = makeRouter({ requestTimeoutMs: 1_000 });
    const primary = new FakeProvider('openai', hang);
    // The fallback needs 400ms; with a starved budget it would time out.
    const fallback = new FakeProvider('groq', slowOk(400));
    router.pool.register(primary, 'fast');
    router.pool.register(fallback, 'fast');

    const result = await router.complete(request(1_000), 'fast');

    expect(result.provider).toBe('groq');
    expect(result.attempts).toBe(2);
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
  });

  it('splits the deadline evenly between two candidates', async () => {
    const router = makeRouter({ requestTimeoutMs: 1_000 });
    const seen: number[] = [];
    const record = (name: string, delayMs: number) => async (req: CompletionRequest): Promise<CompletionResult> => {
      seen.push(req.timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { text: `{"actions":[{"type":"stop"}]}`, latencyMs: delayMs, model: name };
    };
    router.pool.register(new FakeProvider('openai', record('openai', 10)), 'fast');
    router.pool.register(new FakeProvider('groq', record('groq', 10)), 'fast');

    await router.complete(request(1_000), 'fast');

    // Neither candidate may take the whole deadline: the first one gets its
    // share, not "everything except a tiny reserve".
    expect(seen[0]).toBeLessThanOrEqual(600);
    expect(seen[0]).toBeGreaterThanOrEqual(400);
  });
});

describe('router - honest failure accounting', () => {
  it('does not charge a user abort to the provider circuit breaker', async () => {
    const router = makeRouter({ requestTimeoutMs: 5_000, failureThreshold: 3 });
    const provider = new FakeProvider('openai', hang);
    router.pool.register(provider, 'fast');

    for (let round = 0; round < 3; round += 1) {
      const controller = new AbortController();
      const promise = router.complete(request(5_000, controller.signal), 'fast');
      setTimeout(() => controller.abort(), 10);
      await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
    }

    const stats = router.pool.statsFor('openai');
    expect(stats?.failures).toBe(0);
    expect(stats?.consecutiveFailures).toBe(0);
    expect(router.pool.circuitState('openai')).toBe('closed');
  });

  it('still charges real provider failures', async () => {
    const router = makeRouter({ requestTimeoutMs: 5_000, failureThreshold: 2 });
    const provider = new FakeProvider('openai', () =>
      Promise.reject(new ProviderError('openai', 'auth', 'openai: 401', { statusCode: 401, retryable: false })),
    );
    router.pool.register(provider, 'fast');

    await expect(router.complete(request(5_000), 'fast')).rejects.toThrow();
    await expect(router.complete(request(5_000), 'fast')).rejects.toThrow();

    expect(router.pool.statsFor('openai')?.failures).toBe(2);
    expect(router.pool.circuitState('openai')).toBe('open');
  });
});

describe('router - the health probe is actually used', () => {
  it('skips a provider whose health probe failed', async () => {
    const router = makeRouter();
    const dead = new FakeProvider('openai', slowOk(0), { health: false });
    const working = new FakeProvider('groq', slowOk(0));
    router.pool.register(dead, 'fast');
    router.pool.register(working, 'fast');

    await router.pool.probeHealth('openai');
    expect(router.pool.healthOf('openai')?.ok).toBe(false);

    const result = await router.complete(request(1_000), 'fast');

    // The dead provider is never even called: it would only burn the budget.
    expect(dead.calls).toBe(0);
    expect(result.provider).toBe('groq');
  });

  it('probes a provider in the background when it is registered', async () => {
    const router = makeRouter();
    const provider = new FakeProvider('openai', slowOk(0), { health: false });
    router.pool.register(provider, 'fast');

    // The probe starts without anybody waiting for it.
    expect(provider.healthChecks).toBeGreaterThan(0);

    await router.pool.probeHealth('openai');
    expect(router.pool.healthOf('openai')?.ok).toBe(false);
    expect(router.pool.getAvailable('fast').map((p) => p.name)).not.toContain('openai');
  });

  it('never blocks the request path on a health probe', async () => {
    const router = makeRouter({ requestTimeoutMs: 2_000 });
    const provider = new FakeProvider('openai', slowOk(0), { health: 'never' });
    router.pool.register(provider, 'fast');

    const started = Date.now();
    const result = await router.complete(request(2_000), 'fast');

    expect(result.provider).toBe('openai');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('keeps a healthy provider in the rotation', async () => {
    const router = makeRouter();
    const provider = new FakeProvider('openai', slowOk(0));
    router.pool.register(provider, 'fast');

    await router.pool.probeHealth('openai');

    expect(router.pool.healthOf('openai')?.ok).toBe(true);
    expect(router.pool.getAvailable('fast').map((p) => p.name)).toContain('openai');
  });
});
