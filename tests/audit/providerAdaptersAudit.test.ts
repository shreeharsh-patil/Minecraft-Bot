/**
 * Audit of the four concrete provider adapters.
 *
 * These tests pin the wire contract each adapter owns - endpoint, headers,
 * request body, response shape and default model - and cover the three
 * defects found in this slice:
 *
 *  1. OpenRouter dropped `HTTP-Referer` / `X-Title` as soon as the caller
 *     also passed `extraHeaders`: the caller-supplied object replaced the
 *     attribution headers instead of being merged with them.
 *  2. Gemini accepted an answer that the model had to cut short
 *     (`finishReason: MAX_TOKENS`) as if it were a complete plan, so the
 *     planner dropped every action and the router never fell back.
 *  3. Every adapter spread the caller's options *over* its own defaults, so
 *     an option that was present but `undefined` erased the default: the
 *     request went out without a model, or to `/models/undefined`.
 */
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/types/provider.js';
import type { AiProvider, CompletionRequest } from '../../src/types/provider.js';
import { GeminiProvider } from '../../src/ai/providers/GeminiProvider.js';
import { GroqProvider } from '../../src/ai/providers/GroqProvider.js';
import { OpenAIProvider } from '../../src/ai/providers/OpenAIProvider.js';
import { OpenRouterProvider } from '../../src/ai/providers/OpenRouterProvider.js';

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
async function attempt(provider: AiProvider, payload: CompletionRequest = request()): Promise<unknown> {
  return provider.complete(payload).then(
    (result) => result,
    (error: unknown) => error,
  );
}

const OPENAI_OK_BODY = {
  model: 'gpt-4o-mini',
  choices: [
    { index: 0, message: { role: 'assistant', content: '{"actions":[]}' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
};

const GEMINI_OK_BODY = {
  candidates: [
    {
      content: { parts: [{ text: '{"actions":[]}' }], role: 'model' },
      finishReason: 'STOP',
      index: 0,
    },
  ],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
  modelVersion: 'gemini-2.5-flash',
};

describe('provider adapters - endpoint and default model', () => {
  it('posts to the OpenAI chat-completions endpoint with the documented model', async () => {
    const { fetchImpl, calls } = fakeFetch(OPENAI_OK_BODY);
    const provider = new OpenAIProvider({ apiKey: 'sk-test', fetchImpl });

    await provider.complete(request());

    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]?.body['model']).toBe('gpt-4o-mini');
    expect(calls[0]?.headers['authorization']).toBe('Bearer sk-test');
  });

  it('posts to the Groq chat-completions endpoint with the documented model', async () => {
    const { fetchImpl, calls } = fakeFetch(OPENAI_OK_BODY);
    const provider = new GroqProvider({ apiKey: 'gsk-test', fetchImpl });

    await provider.complete(request());

    expect(calls[0]?.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(calls[0]?.body['model']).toBe('llama-3.3-70b-versatile');
    expect(calls[0]?.headers['authorization']).toBe('Bearer gsk-test');
  });

  it('posts to the OpenRouter chat-completions endpoint with the documented model', async () => {
    const { fetchImpl, calls } = fakeFetch(OPENAI_OK_BODY);
    const provider = new OpenRouterProvider({ apiKey: 'or-test', fetchImpl });

    await provider.complete(request());

    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]?.body['model']).toBe('openai/gpt-4o-mini');
    expect(calls[0]?.headers['authorization']).toBe('Bearer or-test');
  });

  it('posts to the native Gemini generateContent endpoint with the key in the query string', async () => {
    const { fetchImpl, calls } = fakeFetch(GEMINI_OK_BODY);
    const provider = new GeminiProvider({ apiKey: 'AIza-test', fetchImpl });

    await provider.complete(request());

    expect(calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIza-test',
    );
    // The key travels in the query string, never in a header.
    expect(calls[0]?.headers['authorization']).toBeUndefined();
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });
});

describe('provider adapters - OpenRouter attribution headers', () => {
  it('sends the referer and title headers when they are configured', async () => {
    const { fetchImpl, calls } = fakeFetch(OPENAI_OK_BODY);
    const provider = new OpenRouterProvider({
      apiKey: 'or-test',
      referer: 'https://bot.example',
      title: 'Minecraft Bot',
      fetchImpl,
    });

    await provider.complete(request());

    expect(calls[0]?.headers['HTTP-Referer']).toBe('https://bot.example');
    expect(calls[0]?.headers['X-Title']).toBe('Minecraft Bot');
  });

  it('keeps the attribution headers when the caller also supplies extra headers', async () => {
    const { fetchImpl, calls } = fakeFetch(OPENAI_OK_BODY);
    const provider = new OpenRouterProvider({
      apiKey: 'or-test',
      referer: 'https://bot.example',
      title: 'Minecraft Bot',
      extraHeaders: { 'X-Custom': 'yes' },
      fetchImpl,
    });

    await provider.complete(request());

    // The caller-supplied header is merged in; it must not replace the
    // headers OpenRouter uses to identify the caller.
    expect(calls[0]?.headers['HTTP-Referer']).toBe('https://bot.example');
    expect(calls[0]?.headers['X-Title']).toBe('Minecraft Bot');
    expect(calls[0]?.headers['X-Custom']).toBe('yes');
    expect(calls[0]?.headers['authorization']).toBe('Bearer or-test');
  });

  it('sends only the caller-supplied headers when no referer or title is configured', async () => {
    const { fetchImpl, calls } = fakeFetch(OPENAI_OK_BODY);
    const provider = new OpenRouterProvider({
      apiKey: 'or-test',
      extraHeaders: { 'X-Custom': 'yes' },
      fetchImpl,
    });

    await provider.complete(request());

    expect(calls[0]?.headers['X-Custom']).toBe('yes');
    expect(calls[0]?.headers['HTTP-Referer']).toBeUndefined();
    expect(calls[0]?.headers['X-Title']).toBeUndefined();
  });
});

describe('provider adapters - Gemini request body', () => {
  it('sends the system prompt as systemInstruction and the turns as contents', async () => {
    const { fetchImpl, calls } = fakeFetch(GEMINI_OK_BODY);
    const provider = new GeminiProvider({ apiKey: 'AIza-test', fetchImpl });

    await provider.complete(
      request({
        messages: [
          { role: 'system', content: 'you are a bot' },
          { role: 'user', content: 'mine 20 stone' },
          { role: 'assistant', content: '{"actions":[]}' },
          { role: 'user', content: 'now place a block' },
        ],
      }),
    );

    const body = calls[0]?.body ?? {};
    expect(body['systemInstruction']).toEqual({ parts: [{ text: 'you are a bot' }] });
    expect(body['contents']).toEqual([
      { role: 'user', parts: [{ text: 'mine 20 stone' }] },
      { role: 'model', parts: [{ text: '{"actions":[]}' }] },
      { role: 'user', parts: [{ text: 'now place a block' }] },
    ]);
    // No `role: system` turn ever reaches Gemini.
    expect(JSON.stringify(body['contents'])).not.toContain('"system"');
  });

  it('asks for JSON through generationConfig and maps the token budget', async () => {
    const { fetchImpl, calls } = fakeFetch(GEMINI_OK_BODY);
    const provider = new GeminiProvider({ apiKey: 'AIza-test', fetchImpl });

    await provider.complete(request({ maxTokens: 512, temperature: 0.4 }));

    expect(calls[0]?.body['generationConfig']).toEqual({
      temperature: 0.4,
      maxOutputTokens: 512,
      responseMimeType: 'application/json',
    });
  });

  it('reads the answer, the model version and the usage out of the response', async () => {
    const { fetchImpl } = fakeFetch(GEMINI_OK_BODY);
    const provider = new GeminiProvider({ apiKey: 'AIza-test', fetchImpl });

    const result = await provider.complete(request());

    expect(result.text).toBe('{"actions":[]}');
    expect(result.model).toContain('gemini-2.5-flash');
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  });
});

describe('provider adapters - truncated Gemini answers', () => {
  const truncatedBody = {
    candidates: [
      {
        content: { parts: [{ text: '{"actions":[{"type":"sto' }], role: 'model' },
        finishReason: 'MAX_TOKENS',
        index: 0,
      },
    ],
  };

  it('rejects an answer that was cut short instead of returning half a plan', async () => {
    const { fetchImpl } = fakeFetch(truncatedBody);
    const provider = new GeminiProvider({ apiKey: 'AIza-test', fetchImpl });

    const error = await attempt(provider);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('parse_error');
    expect((error as ProviderError).message).toContain('truncated');
    expect((error as ProviderError).retryable).toBe(false);
  });

  it('still accepts an answer the model finished on its own', async () => {
    const { fetchImpl } = fakeFetch(GEMINI_OK_BODY);
    const provider = new GeminiProvider({ apiKey: 'AIza-test', fetchImpl });

    const result = await provider.complete(request());

    expect(result.text).toBe('{"actions":[]}');
  });
});

describe('provider adapters - an undefined option must not erase a default', () => {
  it('keeps the OpenAI model when the caller passes an undefined model', async () => {
    const { fetchImpl, calls } = fakeFetch(OPENAI_OK_BODY);
    const provider = new OpenAIProvider({ apiKey: 'sk-test', model: undefined, fetchImpl });

    await provider.complete(request());

    expect(calls[0]?.body['model']).toBe('gpt-4o-mini');
  });

  it('keeps the Groq base URL when the caller passes an undefined base URL', async () => {
    const { fetchImpl, calls } = fakeFetch(OPENAI_OK_BODY);
    const provider = new GroqProvider({ apiKey: 'gsk-test', baseUrl: undefined, fetchImpl });

    await provider.complete(request());

    expect(calls[0]?.url).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('keeps the Gemini model in the URL when the caller passes an undefined model', async () => {
    const { fetchImpl, calls } = fakeFetch(GEMINI_OK_BODY);
    const provider = new GeminiProvider({ apiKey: 'AIza-test', model: undefined, fetchImpl });

    await provider.complete(request());

    expect(calls[0]?.url).toContain('/models/gemini-2.5-flash:generateContent');
    expect(calls[0]?.url).not.toContain('undefined');
  });

  it('keeps the OpenRouter model when the caller passes an undefined model', async () => {
    const { fetchImpl, calls } = fakeFetch(OPENAI_OK_BODY);
    const provider = new OpenRouterProvider({ apiKey: 'or-test', model: undefined, fetchImpl });

    await provider.complete(request());

    expect(calls[0]?.body['model']).toBe('openai/gpt-4o-mini');
  });
});
