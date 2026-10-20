/**
 * Shared wire format for every provider that speaks the OpenAI
 * `/chat/completions` dialect (OpenAI, Groq, OpenRouter).
 *
 * Each concrete adapter is then just an endpoint + default model: there is no
 * duplicated request/response logic between them.
 */
import { ProviderError } from '../../types/provider.js';
import type { CompletionRequest, ProviderErrorKind } from '../../types/provider.js';
import { BaseProvider, asRecord, asString, extractJson, readUsage } from './BaseProvider.js';
import type { BaseProviderOptions, ProviderUsage, WireResult } from './BaseProvider.js';
import { scrubText } from '../../utils/redact.js';

export interface OpenAiCompatibleOptions extends BaseProviderOptions {
  /** Base URL without the `/chat/completions` suffix. */
  baseUrl: string;
  /** Extra headers, e.g. OpenRouter's HTTP-Referer / X-Title. */
  extraHeaders?: Record<string, string>;
}

interface OpenAiChoice {
  index: number;
  message?: { role?: string; content?: string };
  text?: string;
  finish_reason?: string;
}

/**
 * Maps an error envelope's own `type`/`code` onto the shared error taxonomy,
 * so a rate limit is counted as a rate limit and a rejected key as an auth
 * failure. Anything unrecognised stays 'unknown' (and therefore retryable).
 */
function envelopeKind(type: string | undefined, code: string | undefined): ProviderErrorKind {
  const marker = `${type ?? ''} ${code ?? ''}`.toLowerCase();
  if (marker.includes('rate_limit') || marker.includes('rate limit')) return 'rate_limited';
  if (marker.includes('authentication') || marker.includes('permission') || marker.includes('invalid_api_key')) {
    return 'auth';
  }
  if (marker.includes('invalid_request')) return 'invalid_request';
  return 'unknown';
}

/**
 * Mirrors `BaseProvider.httpError`: a rejected key and a malformed request
 * are not worth retrying against the same provider, everything else is.
 */
function envelopeRetryable(kind: ProviderErrorKind): boolean {
  return kind !== 'auth' && kind !== 'invalid_request';
}

/**
 * The OpenAI dialect counts tokens as `prompt_tokens` / `completion_tokens` /
 * `total_tokens`. The shared reader knows the camelCase and `*_count`
 * spellings of the other dialects, so the block is normalised here - without
 * it, no OpenAI-compatible provider ever reports a token count.
 */
const USAGE_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ['prompt_tokens', 'promptTokens'],
  ['completion_tokens', 'completionTokens'],
  ['total_tokens', 'totalTokens'],
];

function readOpenAiUsage(source: Record<string, unknown> | undefined): ProviderUsage | undefined {
  if (!source) return undefined;
  const normalised: Record<string, unknown> = { ...source };
  for (const [openAi, shared] of USAGE_SPELLINGS) {
    if (normalised[shared] === undefined && normalised[openAi] !== undefined) {
      normalised[shared] = normalised[openAi];
    }
  }
  return readUsage(normalised);
}

export abstract class OpenAiCompatibleProvider extends BaseProvider {
  private readonly extraHeaders: Record<string, string>;

  constructor(options: OpenAiCompatibleOptions) {
    super(options);
    this.extraHeaders = options.extraHeaders ?? {};
  }

  protected override endpoint(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  protected override headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
      ...this.extraHeaders,
    };
  }

  protected override payload(request: CompletionRequest): unknown {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: request.temperature ?? 0.2,
      stream: false,
    };
    if (request.maxTokens !== undefined) body['max_tokens'] = request.maxTokens;
    if (request.jsonMode) {
      // Not every OpenAI-compatible host implements response_format; asking for
      // it is still correct, and the planner recovers JSON from prose anyway.
      body['response_format'] = { type: 'json_object' };
    }
    return body;
  }

  protected override readResult(payload: unknown): WireResult {
    const root = asRecord(payload);
    if (!root) return { text: '' };

    const errorPayload = root['error'];
    if (errorPayload !== undefined && errorPayload !== null) {
      // Some compatible hosts answer 200 with an error envelope.
      throw this.envelopeError(asRecord(errorPayload), asString(errorPayload));
    }

    const choices: OpenAiChoice[] = Array.isArray(root['choices']) ? (root['choices'] as OpenAiChoice[]) : [];
    const first = choices[0];
    const text = first ? (asString(first.message?.content) ?? asString(first.text) ?? '') : '';

    if (first?.finish_reason === 'length' && extractJson(text) === undefined) {
      // The answer ran into the token limit, so the JSON is cut in half. The
      // planner would find nothing in it and the player would be told the bot
      // "could not work out what that means"; failing here lets the router
      // try the next provider instead of shipping half a plan.
      throw new ProviderError(this.name, 'parse_error', `${this.name}: response was truncated (finish_reason=length)`, {
        retryable: false,
      });
    }

    const model = asString(root['model']);
    const usage = readOpenAiUsage(asRecord(root['usage']));

    return {
      text,
      ...(model !== undefined ? { model } : {}),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  /**
   * Turns a "200 with an error envelope" into the shared ProviderError
   * taxonomy.
   *
   * The envelope is never swallowed: an error that carries only a `code` (no
   * `message`) used to fall through as an empty completion and was reported
   * upstream as "the model returned no text" - a parse error that hides the
   * real cause (a rate limit, a revoked key) behind a misleading one. The
   * message is scrubbed because a host is free to echo the key back.
   */
  private envelopeError(block: Record<string, unknown> | undefined, plain: string | undefined): ProviderError {
    const type = asString(block?.['type']);
    const code = asString(block?.['code']);
    const detail = asString(block?.['message']) ?? plain ?? code ?? type ?? 'provider returned an error envelope';
    const kind = envelopeKind(type, code);
    return new ProviderError(this.name, kind, `${this.name}: ${scrubText(detail)}`, {
      retryable: envelopeRetryable(kind),
    });
  }
}