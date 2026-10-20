/**
 * Audit of the shared HTTP plumbing (`BaseProvider`) and the provider pool
 * (`ProviderPool`).
 *
 * Three defects are pinned here:
 *
 *  - the pool reserved the single half-open probe slot but never released it,
 *    so one failed probe could strand a provider in `half_open` for good: it
 *    was skipped by `getAvailable()` from then on and the bot lost that
 *    provider (every request ended in `AIUnavailableError`) until a restart;
 *  - `BaseProvider.complete()` let a raw adapter error escape, breaking the
 *    "one error taxonomy" contract of the layer (an OpenAI-compatible host
 *    that answers 200 with an error envelope does exactly that);
 *  - a non-finite `timeoutMs` overflowed the platform timer: `setTimeout`
 *    silently rewrites any delay above 2^31-1 ms into 1ms, so every request
 *    failed instantly as a timeout.
 */
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/types/provider.js';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  ProviderName,
} from '../../src/types/provider.js';
import { BaseProvider } from '../../src/ai/providers/BaseProvider.js';
import type { WireResult } from '../../src/ai/providers/BaseProvider.js';
import { ProviderPool } from '../../src/ai/providers/ProviderPool.js';

// --- helpers -------------------------------------------------------------------

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    jsonMode: true,
    timeoutMs: 5_000,
    ...overrides,
  };
}

/**
 * A `fetch` that answers after `delayMs` and honours the abort signal, just
 * like the real one: an aborted request rejects instead of hanging forever.
 */
function fakeFetch(options: { delayMs?: number; body?: unknown; status?: number } = {}): typeof fetch {
  const delayMs = options.delayMs ?? 0;
  const body = options.body ?? { text: 'ok' };
  const status = options.status ?? 200;
  const impl = (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(
          new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
        );
      }, delayMs);
      const signal = init?.signal;
      const onAbort = (): void => {
        clearTimeout(timer);
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  return impl;
}

/** A concrete adapter over the shared HTTP plumbing. */
class TestProvider extends BaseProvider {
  private readonly read: (payload: unknown) => WireResult;

  constructor(options: {
    fetchImpl?: typeof fetch;
    apiKey?: string;
    read?: (payload: unknown) => WireResult;
  } = {}) {
    super({
      name: 'openai',
      apiKey: options.apiKey ?? 'test-key',
      model: 'test-model',
      baseUrl: 'https://api.example.test/v1',
      fetchImpl: options.fetchImpl,
    });
    this.read = options.read ?? (() => ({ text: 'ok' }));
  }

  protected override endpoint(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  protected override headers(): Record<string, string> {
    return { 'content-type': 'application/json' };
  }

  protected override payload(req: CompletionRequest): unknown {
    return { model: this.model, messages: req.messages };
  }

  protected override readResult(payload: unknown): WireResult {
    return this.read(payload);
  }
}

/** Runs `complete()` and returns whatever it threw (or the result). */
async function attempt(provider: TestProvider, payload: CompletionRequest = request()): Promise<unknown> {
  return provider.complete(payload).then(
    (result) => result,
    (error: unknown) => error,
  );
}

/** A scriptable provider: no HTTP, deterministic outcomes. */
class FakeProvider implements AiProvider {
  public readonly name: ProviderName;
  public readonly model: string;
  public disposed = false;

  private readonly throwOnDispose: boolean;

  constructor(name: ProviderName, options: { throwOnDispose?: boolean } = {}) {
    this.name = name;
    this.model = `${name}-model`;
    this.throwOnDispose = options.throwOnDispose ?? false;
  }

  public isAvailable(): boolean {
    return true;
  }

  public healthCheck(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public complete(): Promise<CompletionResult> {
    return Promise.resolve({ text: '{}', latencyMs: 1, model: this.model });
  }

  public dispose(): void {
    this.disposed = true;
    if (this.throwOnDispose) throw new Error('dispose failed');
  }
}

// --- BaseProvider ---------------------------------------------------------------

describe('BaseProvider - the timeout ceiling', () => {
  it('does not turn an unbounded timeout into a 1ms timer', async () => {
    // `setTimeout` rewrites every delay above 2^31-1 ms into 1ms, so a
    // "no deadline" timeout aborted the request instantly and every call
    // failed as a timeout. The planner uses `Number.MAX_SAFE_INTEGER` as its
    // "no deadline" sentinel.
    const provider = new TestProvider({ fetchImpl: fakeFetch({ delayMs: 25 }) });

    const result = await provider.complete(request({ timeoutMs: Number.MAX_SAFE_INTEGER }));

    expect(result.text).toBe('ok');
  });

  it('keeps honouring a finite timeout', async () => {
    const provider = new TestProvider({ fetchImpl: fakeFetch({ delayMs: 5_000 }) });

    const error = await attempt(provider, request({ timeoutMs: 30 }));

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('timeout');
  });

  it('fails fast on a timeout that is not a number', async () => {
    // NaN is a caller bug, not a deadline: it must not become a request that
    // never ends either.
    const provider = new TestProvider({ fetchImpl: fakeFetch({ delayMs: 25 }) });

    const error = await attempt(provider, request({ timeoutMs: Number.NaN }));

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('timeout');
  });
});

describe('BaseProvider - the error taxonomy', () => {
  it('never lets a raw adapter error escape complete()', async () => {
    // An adapter may throw while reading the payload (a host that answers
    // 200 with an error envelope). The taxonomy belongs to this layer: a raw
    // error must never leak above it.
    const provider = new TestProvider({
      fetchImpl: fakeFetch(),
      read: () => {
        throw new Error('host answered 200 with an error envelope');
      },
    });

    const error = await attempt(provider);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('unknown');
    expect((error as ProviderError).message).toContain('error envelope');
  });

  it('scrubs a credential an adapter echoed back', async () => {
    const provider = new TestProvider({
      fetchImpl: fakeFetch(),
      read: () => {
        throw new Error('Incorrect API key provided: sk-proj-abcdefghijklmnopqrst');
      },
    });

    const error = await attempt(provider);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).not.toContain('sk-proj-abcdefghijklmnopqrst');
    expect((error as ProviderError).message).toContain('[REDACTED]');
  });

  it('keeps a ProviderError an adapter raised itself', async () => {
    const provider = new TestProvider({
      fetchImpl: fakeFetch(),
      read: () => {
        throw new ProviderError('openai', 'rate_limited', 'openai: rate limited', { retryable: true });
      },
    });

    const error = await attempt(provider);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('rate_limited');
  });
});

// --- ProviderPool ----------------------------------------------------------------

describe('ProviderPool - the half-open probe reservation', () => {
  it('does not strand a provider after a failed half-open probe', () => {
    let now = 1_000_000;
    const pool = new ProviderPool({ failureThreshold: 2, cooldownMs: 5_000, now: () => now });
    pool.register(new FakeProvider('openai'), 'fast');

    // Two consecutive failures trip the breaker.
    pool.recordFailure('openai');
    pool.recordFailure('openai');
    expect(pool.circuitState('openai')).toBe('open');

    // After the cooldown the circuit half-opens and the provider is eligible
    // again. No 'planning' provider is configured, so the pool falls back
    // across tiers and hands the half-open provider out.
    now += 5_001;
    expect(pool.circuitState('openai')).toBe('half_open');
    expect(pool.getAvailable('planning').map((p) => p.name)).toEqual(['openai']);

    // The probe fails: the circuit re-opens.
    pool.recordFailure('openai');
    expect(pool.circuitState('openai')).toBe('open');

    // After the next cooldown the provider must be eligible again. The
    // reservation of the finished probe must not keep it out for good - the
    // bot would lose the provider until a restart.
    now += 5_001;
    expect(pool.circuitState('openai')).toBe('half_open');
    expect(pool.getAvailable('planning').map((p) => p.name)).toEqual(['openai']);
  });

  it('does not strand a provider whose half-open probe was never concluded', () => {
    let now = 1_000_000;
    const pool = new ProviderPool({ failureThreshold: 2, cooldownMs: 5_000, now: () => now });
    pool.register(new FakeProvider('openai'), 'fast');
    pool.recordFailure('openai');
    pool.recordFailure('openai');

    now += 5_001;
    expect(pool.getAvailable('planning').map((p) => p.name)).toEqual(['openai']);

    // The caller aborted the request, so no outcome is ever recorded for
    // the probe. The reservation must not keep the provider out for good.
    now += 5_001;
    expect(pool.getAvailable('planning').map((p) => p.name)).toEqual(['openai']);
  });

  it('re-arms the circuit after a successful half-open probe', () => {
    let now = 1_000_000;
    const pool = new ProviderPool({ failureThreshold: 2, cooldownMs: 5_000, now: () => now });
    pool.register(new FakeProvider('openai'), 'fast');
    pool.recordFailure('openai');
    pool.recordFailure('openai');

    now += 5_001;
    expect(pool.getAvailable('planning').map((p) => p.name)).toEqual(['openai']);

    // The probe succeeds: the circuit closes.
    pool.recordSuccess('openai', 12);
    expect(pool.circuitState('openai')).toBe('closed');

    // A later outage trips the breaker again, and the provider must come
    // back after the cooldown.
    pool.recordFailure('openai');
    pool.recordFailure('openai');
    expect(pool.circuitState('openai')).toBe('open');
    now += 5_001;
    expect(pool.circuitState('openai')).toBe('half_open');
    expect(pool.getAvailable('planning').map((p) => p.name)).toEqual(['openai']);
  });
});

describe('ProviderPool - disposal', () => {
  it('keeps releasing the other providers when one throws synchronously', async () => {
    const pool = new ProviderPool({ failureThreshold: 2, cooldownMs: 1_000 });
    const broken = new FakeProvider('openai', { throwOnDispose: true });
    const healthy = new FakeProvider('groq');
    pool.register(broken, 'fast');
    pool.register(healthy, 'fast');

    await expect(pool.disposeAll()).resolves.toBeUndefined();

    expect(healthy.disposed).toBe(true);
    expect(pool.all()).toHaveLength(0);
  });
});
