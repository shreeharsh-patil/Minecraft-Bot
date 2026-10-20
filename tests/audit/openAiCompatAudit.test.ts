/**
 * Audit of the shared OpenAI-compatible provider and the `ai/` barrel.
 *
 * Two things are pinned here:
 *  - the wire contract (endpoint, headers, request body, non-streaming
 *    response) that every OpenAI-compatible adapter shares;
 *  - the error taxonomy: a host that answers 200 with an error envelope, or
 *    an answer that was cut off by the token limit, must fail loudly enough
 *    for the router to fall back to another provider instead of slipping
 *    through as a successful-but-empty reply.
 *
 * The barrel part is a type-level regression: `tsc --noEmit` fails when the
 * barrel stops exporting the types its own public API refers to.
 */
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/types/provider.js';
import type { CompletionRequest } from '../../src/types/provider.js';
import { OpenAiCompatibleProvider } from '../../src/ai/providers/OpenAiCompatibleProvider.js';
import type { OpenAiCompatibleOptions } from '../../src/ai/providers/OpenAiCompatibleProvider.js';
import * as aiBarrel from '../../src/ai/index.js';
import type {
  OpenAiCompatibleOptions as BarrelOpenAiCompatibleOptions,
  PlannerLike,
  ProviderUsage,
} from '../../src/ai/index.js';

/** A concrete adapter over the shared OpenAI-compatible dialect. */
class TestProvider extends OpenAiCompatibleProvider {
  constructor(options: Partial<OpenAiCompatibleOptions> = {}) {
    super({
      name: 'openai',
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://api.example.test/v1',
      ...options,
    });
  }
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A `fetch` that answers with one canned JSON body and records the call. */
function fakeFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    calls.push({ url, headers, body: parsed });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetchImpl, calls };
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'mine 20 stone' },
    ],
    jsonMode: true,
    temperature: 0.3,
    maxTokens: 256,
    timeoutMs: 2_000,
    ...overrides,
  };
}

/** Runs `complete()` and returns whatever it threw (or the result). */
async function attempt(
  provider: TestProvider,
  payload: CompletionRequest = request(),
): Promise<unknown> {
  return provider.complete(payload).then(
    (result) => result,
    (error: unknown) => error,
  );
}

const OK_BODY = {
  model: 'gpt-4o-mini-2024-07-18',
  choices: [{ index: 0, message: { role: 'assistant', content: '{"actions":[]}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
};

describe('OpenAI-compatible provider - wire contract', () => {
  it('posts the chat-completions shape with the auth and content-type headers', async () => {
    const { fetchImpl, calls } = fakeFetch(OK_BODY);
    const provider = new TestProvider({ fetchImpl });

    await provider.complete(request());

    const call = calls[0];
    expect(call?.url).toBe('https://api.example.test/v1/chat/completions');
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.headers['accept']).toBe('application/json');
    expect(call?.headers['authorization']).toBe('Bearer test-key');
    expect(call?.body['model']).toBe('test-model');
    expect(call?.body['stream']).toBe(false);
    expect(call?.body['temperature']).toBe(0.3);
    expect(call?.body['max_tokens']).toBe(256);
    expect(call?.body['response_format']).toEqual({ type: 'json_object' });
    expect(call?.body['messages']).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'mine 20 stone' },
    ]);
  });

  it('forwards the caller-supplied extra headers', async () => {
    const { fetchImpl, calls } = fakeFetch(OK_BODY);
    const provider = new TestProvider({
      fetchImpl,
      extraHeaders: { 'HTTP-Referer': 'https://bot.example', 'X-Title': 'Minecraft Bot' },
    });

    await provider.complete(request());

    expect(calls[0]?.headers['HTTP-Referer']).toBe('https://bot.example');
    expect(calls[0]?.headers['X-Title']).toBe('Minecraft Bot');
    expect(calls[0]?.headers['authorization']).toBe('Bearer test-key');
  });

  it('reads a non-streaming completion and reports the model and the usage', async () => {
    const { fetchImpl } = fakeFetch(OK_BODY);
    const provider = new TestProvider({ fetchImpl });

    const result = await provider.complete(request());

    expect(result.text).toBe('{"actions":[]}');
    expect(result.model).toBe('gpt-4o-mini-2024-07-18');
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  });
});

describe('OpenAI-compatible provider - error envelopes', () => {
  it('raises the shared ProviderError for a 200 carrying an error envelope', async () => {
    const { fetchImpl } = fakeFetch({ error: { message: 'Rate limit reached', type: 'rate_limit_error' } });
    const provider = new TestProvider({ fetchImpl });

    const error = await attempt(provider);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('rate_limited');
    expect((error as ProviderError).retryable).toBe(true);
    expect((error as ProviderError).message).toContain('Rate limit reached');
  });

  it('does not swallow an error envelope that carries only a code', async () => {
    const { fetchImpl } = fakeFetch({ error: { code: 'insufficient_quota' } });
    const provider = new TestProvider({ fetchImpl });

    const error = await attempt(provider);

    expect(error).toBeInstanceOf(ProviderError);
    // Not a parse error: the host did answer, it just answered with an error.
    expect((error as ProviderError).kind).not.toBe('parse_error');
    expect((error as ProviderError).message).toContain('insufficient_quota');
  });

  it('treats a plain-string error field as an error too', async () => {
    const { fetchImpl } = fakeFetch({ error: 'Invalid API key' });
    const provider = new TestProvider({ fetchImpl });

    const error = await attempt(provider);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain('Invalid API key');
  });

  it('scrubs a credential the host echoed back in the error message', async () => {
    // Assembled from fragments on purpose: a literal that looks exactly like
    // a real credential would trip the repository's secret-scanning push
    // protection. The shape is what matters here.
    const leaked = ['sk', 'proj', 'abcdefghijklmnopqrst'].join('-');
    const { fetchImpl } = fakeFetch({
      error: { message: `Incorrect API key provided: ${leaked}` },
    });
    const provider = new TestProvider({ fetchImpl });

    const error = await attempt(provider);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).not.toContain(leaked);
    expect((error as ProviderError).message).toContain('[REDACTED]');
  });
});

describe('OpenAI-compatible provider - truncated answers', () => {
  it('reports a truncated answer so the router can try another provider', async () => {
    const { fetchImpl } = fakeFetch({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '{"actions":[{"type":"sto' },
          finish_reason: 'length',
        },
      ],
    });
    const provider = new TestProvider({ fetchImpl });

    const error = await attempt(provider);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('parse_error');
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as ProviderError).message).toContain('truncated');
  });

  it('keeps a truncated answer that still carries a complete JSON object', async () => {
    const { fetchImpl } = fakeFetch({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '{"actions":[{"type":"stop"}]}' },
          finish_reason: 'length',
        },
      ],
    });
    const provider = new TestProvider({ fetchImpl });

    const result = await provider.complete(request());

    expect(result.text).toBe('{"actions":[{"type":"stop"}]}');
  });
});

describe('ai/ barrel', () => {
  it('exports every runtime member', () => {
    for (const [name, value] of Object.entries(aiBarrel)) {
      expect(value, `barrel export "${name}" is undefined`).toBeDefined();
    }
  });

  it('exports the provider adapters and their base URLs', () => {
    expect(aiBarrel.OpenAiCompatibleProvider).toBeTypeOf('function');
    expect(aiBarrel.OpenAIProvider).toBeTypeOf('function');
    expect(aiBarrel.GroqProvider).toBeTypeOf('function');
    expect(aiBarrel.OpenRouterProvider).toBeTypeOf('function');
    expect(aiBarrel.GeminiProvider).toBeTypeOf('function');
    expect(aiBarrel.OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
    expect(aiBarrel.GROQ_BASE_URL).toBe('https://api.groq.com/openai/v1');
    expect(aiBarrel.OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1');
    expect(aiBarrel.GEMINI_BASE_URL).toBe('https://generativelanguage.googleapis.com/v1beta');
  });

  it('exports the types its own public API refers to', () => {
    // Type-level regression: `tsc --noEmit` fails when the barrel stops
    // exporting one of these names.
    const options: BarrelOpenAiCompatibleOptions = {
      name: 'openai',
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://api.example.test/v1',
    };
    const usage: ProviderUsage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
    const planner: PlannerLike = {
      plan: () => Promise.resolve({ actions: [], dropped: [], provider: null, latencyMs: 0, rawText: '' }),
    };

    expect(options.baseUrl).toBe('https://api.example.test/v1');
    expect(usage.totalTokens).toBe(3);
    expect(typeof planner.plan).toBe('function');
  });
});
