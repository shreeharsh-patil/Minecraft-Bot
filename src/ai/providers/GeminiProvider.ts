/**
 * Google Gemini - native `generateContent` REST API (NOT OpenAI-compatible).
 *
 * Endpoint:
 *   https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=KEY
 *
 * Differences from the OpenAI dialect that this adapter owns:
 *  - the key goes in the query string, so the URL must never be logged as-is;
 *  - `systemInstruction` carries the system prompt, not a `role: system` message;
 *  - `contents[].parts[].text` carries user/assistant turns;
 *  - JSON is requested with `generationConfig.responseMimeType`;
 *  - `finishReason: MAX_TOKENS` means the answer was cut short, so it is
 *    rejected instead of being passed off as a complete plan.
 */
import { ProviderError } from '../../types/provider.js';
import type { CompletionRequest } from '../../types/provider.js';
import { BaseProvider, asRecord, asString, readUsage } from './BaseProvider.js';
import type { BaseProviderOptions, WireResult } from './BaseProvider.js';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';

export interface GeminiProviderOptions extends BaseProviderOptions {
  baseUrl?: string;
}

/** Split the prompt into the system instruction and the conversational turns. */
function splitMessages(request: CompletionRequest): {
  system: string[];
  turns: Array<{ role: 'user' | 'model'; text: string }>;
} {
  const system: string[] = [];
  const turns: Array<{ role: 'user' | 'model'; text: string }> = [];
  for (const message of request.messages) {
    if (message.content.trim().length === 0) continue;
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }
    turns.push({ role: message.role === 'assistant' ? 'model' : 'user', text: message.content });
  }
  // Gemini requires at least one `contents` entry.
  if (turns.length === 0) turns.push({ role: 'user', text: 'Respond with the requested JSON.' });
  return { system, turns };
}

export class GeminiProvider extends BaseProvider {
  constructor(options: Partial<GeminiProviderOptions> = {}) {
    super({
      name: 'gemini',
      ...options,
      model: options.model ?? GEMINI_DEFAULT_MODEL,
      baseUrl: options.baseUrl ?? GEMINI_BASE_URL,
      apiKey: options.apiKey ?? '',
    });
  }

  protected override endpoint(): string {
    return `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(
      this.apiKey,
    )}`;
  }

  protected override headers(): Record<string, string> {
    // The key travels in the query string (required by this API version), so no
    // Authorization header is sent and neither is ever logged.
    return {
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  protected override payload(request: CompletionRequest): unknown {
    const { system, turns } = splitMessages(request);
    const generationConfig: Record<string, unknown> = {
      temperature: request.temperature ?? 0.2,
    };
    if (request.maxTokens !== undefined) generationConfig['maxOutputTokens'] = request.maxTokens;
    if (request.jsonMode) {
      // Gemini's equivalent of OpenAI's response_format.
      generationConfig['responseMimeType'] = 'application/json';
    }

    const body: Record<string, unknown> = {
      contents: turns.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
      generationConfig,
    };
    if (system.length > 0) {
      body['systemInstruction'] = { parts: [{ text: system.join('\n\n') }] };
    }
    return body;
  }

  protected override readResult(payload: unknown): WireResult {
    const root = asRecord(payload);
    if (!root) return { text: '' };

    const candidates = Array.isArray(root['candidates']) ? root['candidates'] : [];
    const first = asRecord(candidates[0]);
    const content = asRecord(first?.['content']);
    const parts = Array.isArray(content?.['parts']) ? content['parts'] : [];

    let text = '';
    for (const part of parts) {
      const piece = asString(asRecord(part)?.['text']);
      if (piece !== undefined) text += piece;
    }

    // `MAX_TOKENS` means the generation hit the per-request token limit, so
    // the answer is incomplete. Gemini counts the reasoning tokens of a
    // thinking model against `maxOutputTokens`, which is why a small budget
    // regularly truncates the JSON in the middle. Handing that half-plan
    // back as a complete answer would make the planner drop every action
    // without the router ever trying the next provider.
    if (asString(first?.['finishReason']) === 'MAX_TOKENS') {
      throw new ProviderError(
        this.name,
        'parse_error',
        `${this.name}: response was truncated (MAX_TOKENS)`,
        { retryable: false },
      );
    }

    const usage = readUsage(asRecord(root['usageMetadata']));
    return {
      text,
      ...(asString(root['modelVersion']) !== undefined
        ? { model: `${this.model} (${asString(root['modelVersion']) as string})` }
        : {}),
      ...(usage ? { usage } : {}),
    };
  }
}