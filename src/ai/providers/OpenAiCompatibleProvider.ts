/**
 * Shared wire format for every provider that speaks the OpenAI
 * `/chat/completions` dialect (OpenAI, Groq, OpenRouter).
 *
 * Each concrete adapter is then just an endpoint + default model: there is no
 * duplicated request/response logic between them.
 */
import type { CompletionRequest } from '../../types/provider.js';
import { BaseProvider, asRecord, asString, readUsage } from './BaseProvider.js';
import type { BaseProviderOptions, WireResult } from './BaseProvider.js';

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

    const errorBlock = asRecord(root['error']);
    if (errorBlock) {
      // Some compatible hosts answer 200 with an error envelope.
      const message = asString(errorBlock['message']);
      if (message !== undefined) throw new Error(message);
    }

    const choices: OpenAiChoice[] = Array.isArray(root['choices']) ? (root['choices'] as OpenAiChoice[]) : [];
    const first = choices[0];
    const text = first ? (asString(first.message?.content) ?? asString(first.text) ?? '') : '';
    const model = asString(root['model']);
    const usage = readUsage(asRecord(root['usage']));

    return {
      text,
      ...(model !== undefined ? { model } : {}),
      ...(usage !== undefined ? { usage } : {}),
    };
  }
}