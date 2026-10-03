/**
 * Provider fallback, circuit breaker and deadline behaviour.
 *
 * Everything here runs against fake providers - no network, no API keys, and
 * the only real timers are the deliberately-bounded "B hangs" case.
 */
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/types/provider.js';
import type { AiProvider, CompletionRequest, CompletionResult, ProviderName } from '../../src/types/provider.js';
import { AIRouter, AIUnavailableError } from '../../src/ai/router.js';
import type { AIRouterOptions } from '../../src/ai/router.js';
import { extractJson } from '../../src/ai/providers/BaseProvider.js';

type Behaviour = 'ok' | 'rate_limited' | 'hang' | 'server_error' | 'network' | 'auth';

/** A scriptable AiProvider: no HTTP, deterministic outcomes. */
class FakeProvider implements AiProvider {
  public readonly name: ProviderName;
  public readonly model: string;
  public calls = 0;
  /** Latency reported on success; seeds the EMA ranking. */
  public successLatencyMs = 10;

  private behaviour: Behaviour;
  private readonly available: boolean;

  constructor(name: ProviderName, behaviour: Behaviour, options: { model?: string; available?: boolean } = {}) {
    this.name = name;
    this.model = options.model ?? `${name}-model`;
    this.behaviour = behaviour;
    this.available = options.available ?? true;
  }

  public setBehaviour(behaviour: Behaviour): void {
    this.behaviour = behaviour;
  }

  public isAvailable(): boolean {
    return this.available;
  }

  public healthCheck(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  public async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls += 1;
    switch (this.behaviour) {
      case 'ok':
        return {
          text: '{"actions":[{"type":"stop"}]}',
          latencyMs: this.successLatencyMs,
          model: this.model,
        };
      case 'rate_limited':
        throw new ProviderError(this.name, 'rate_limited', `${this.name}: 429`, {
          statusCode: 429,
          retryable: true,
        });
      case 'server_error':
        throw new ProviderError(this.name, 'server_error', `${this.name}: 503`, {
          statusCode: 503,
          retryable: true,
        });
      case 'network':
        throw new ProviderError(this.name, 'network', `${this.name}: ECONNREFUSED`, { retryable: true });
      case 'auth':
        throw new ProviderError(this.name, 'auth', `${this.name}: 401`, {
          statusCode: 401,
          retryable: false,
        });
      case 'hang':
        // Respects the deadline exactly like a real adapter would.
        return new Promise<CompletionResult>((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new ProviderError(this.name, 'timeout', `${this.name}: timed out`, { retryable: true }));
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
  }

  public dispose(): void {
    /* nothing to release */
  }
}

function request(timeoutMs = 5_000): CompletionRequest {
  return { messages: [{ role: 'user', content: 'hello' }], jsonMode: true, timeoutMs };
}

function makeRouter(overrides: Partial<AIRouterOptions> = {}): AIRouter {
  return new AIRouter({
    requestTimeoutMs: 5_000,
    failureThreshold: 2,
    cooldownMs: 1_000,
    ...overrides,
  });
}

describe('provider fallback', () => {
  it('falls back A -> B -> C when A is rate limited and B times out', async () => {
    const router = makeRouter({ requestTimeoutMs: 400 });
    const a = new FakeProvider('openai', 'rate_limited');
    const b = new FakeProvider('groq', 'hang');
    const c = new FakeProvider('openrouter', 'ok');

    for (const provider of [a, b, c]) router.pool.register(provider, 'fast');

    const started = Date.now();
    const result = await router.complete(request(400), 'fast');
    const elapsed = Date.now() - started;

    expect(result.provider).toBe('openrouter');
    expect(result.attempts).toBe(3);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
    expect(c.calls).toBe(1);

    // The whole fallback chain stays inside the deadline.
    expect(elapsed).toBeLessThan(400);

    const stats = router.pool.stats();
    expect(stats.find((s) => s.name === 'openai')?.rateLimited).toBe(1);
    expect(stats.find((s) => s.name === 'groq')?.timeouts).toBe(1);
    expect(stats.find((s) => s.name === 'openrouter')?.successes).toBe(1);
  });

  it('stops at the deadline instead of hanging when every provider stalls', async () => {
    const router = makeRouter({ requestTimeoutMs: 250 });
    const a = new FakeProvider('openai', 'hang');
    const b = new FakeProvider('gemini', 'hang');
    for (const provider of [a, b]) router.pool.register(provider, 'fast');

    const started = Date.now();
    await expect(router.complete(request(250), 'fast')).rejects.toBeInstanceOf(AIUnavailableError);
    expect(Date.now() - started).toBeLessThan(600);
  });

  it('skips providers whose circuit is open and probes once half-open', async () => {
    let now = 1_000_000;
    const router = makeRouter({ failureThreshold: 2, cooldownMs: 5_000, now: () => now });
    const failing = new FakeProvider('openai', 'server_error');
    const healthy = new FakeProvider('groq', 'ok');
    router.pool.register(failing, 'fast');
    router.pool.register(healthy, 'fast');

    // Two consecutive failures trip the breaker. An unmeasured provider is
    // probed first, so the second call also hits A and fails again.
    expect(await router.complete(request(200), 'fast')).toMatchObject({ provider: 'groq' });
    expect(await router.complete(request(200), 'fast')).toMatchObject({ provider: 'groq' });
    expect(router.pool.circuitState('openai')).toBe('open');

    // While open, A is never selected again.
    const callsBefore = failing.calls;
    for (let i = 0; i < 3; i += 1) await router.complete(request(200), 'fast');
    expect(failing.calls).toBe(callsBefore);
    expect(router.pool.getAvailable('fast').map((p) => p.name)).not.toContain('openai');

    // After the cooldown the circuit half-opens and A is eligible again.
    now += 5_001;
    expect(router.pool.circuitState('openai')).toBe('half_open');
    expect(router.pool.getAvailable('fast').map((p) => p.name)).toContain('openai');

    // A successful probe closes the circuit.
    failing.setBehaviour('ok');
    await router.complete(request(200), 'fast');
    expect(router.pool.circuitState('openai')).toBe('closed');
  });

it('does not fall back when the caller aborts (the !stop path)', async () => {
    const router = makeRouter({ requestTimeoutMs: 5_000 });
    const a = new FakeProvider('openai', 'hang');
    const b = new FakeProvider('groq', 'ok');
    router.pool.register(a, 'fast');
    router.pool.register(b, 'fast');

    const controller = new AbortController();
    const promise = router.complete({ ...request(5_000), signal: controller.signal }, 'fast');
    setTimeout(() => controller.abort(), 30);

    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
    expect(b.calls).toBe(0);
  });

  it('ranks the fastest healthy provider first for the fast tier', async () => {
    const router = makeRouter();
    const slow = new FakeProvider('openai', 'ok');
    slow.successLatencyMs = 900;
    const fast = new FakeProvider('groq', 'ok');
    fast.successLatencyMs = 50;

    router.pool.register(slow, 'fast');
    router.pool.register(fast, 'fast');

    // Prime the EMA with one successful call each.
    await router.complete(request(), 'fast');
    await router.complete(request(), 'fast');

    expect(router.rank('fast').map((p) => p.name)[0]).toBe('groq');
  });

  it('prefers the planning-tier provider for the planning tier', () => {
    const router = makeRouter();
    const groqFast = new FakeProvider('groq', 'ok');
    const gemini = new FakeProvider('gemini', 'ok');
    router.pool.register(groqFast, 'fast');
    router.pool.register(gemini, 'planning');

    expect(router.rank('planning').map((p) => p.name)).toEqual(['gemini']);
    expect(router.rank('fast').map((p) => p.name)).toEqual(['groq']);
  });

  it('skips providers with no API key', async () => {
    const router = makeRouter();
    const keyless = new FakeProvider('openai', 'ok', { available: false });
    const working = new FakeProvider('groq', 'ok');
    router.pool.register(keyless, 'fast');
    router.pool.register(working, 'fast');

    const result = await router.complete(request(), 'fast');
    expect(result.provider).toBe('groq');
    expect(keyless.calls).toBe(0);
  });

  it('falls back past a provider with a rejected key, and opens its circuit', async () => {
    const router = makeRouter({ failureThreshold: 1 });
    const badKey = new FakeProvider('openai', 'auth');
    const working = new FakeProvider('groq', 'ok');
    router.pool.register(badKey, 'fast');
    router.pool.register(working, 'fast');

    // A 401 is specific to that provider: Groq must still serve the request.
    const result = await router.complete(request(), 'fast');
    expect(result.provider).toBe('groq');
    expect(working.calls).toBe(1);

    // The dead key is now suppressed rather than retried forever.
    expect(router.pool.circuitState('openai')).toBe('open');
    await router.complete(request(), 'fast');
    expect(badKey.calls).toBe(1);
  });

  it('reports AIUnavailableError with per-provider failure detail', async () => {
    const router = makeRouter();
    const a = new FakeProvider('openai', 'rate_limited');
    const b = new FakeProvider('groq', 'network');
    router.pool.register(a, 'fast');
    router.pool.register(b, 'fast');

    await expect(router.complete(request(), 'fast')).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof AIUnavailableError)) return false;
      const kinds = error.failures.map((f) => `${f.provider}:${f.kind}`);
      return kinds.includes('openai:rate_limited') && kinds.includes('groq:network');
    });
  });
});

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON wrapped in a code fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON embedded in prose', () => {
    expect(extractJson('Sure! Here is the plan:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('returns undefined for text with no JSON', () => {
    expect(extractJson('I cannot help with that.')).toBeUndefined();
  });
});