/**
 * OpenRouter. OpenAI-compatible, routes to many upstream models.
 * Endpoint: https://openrouter.ai/api/v1/chat/completions
 * OpenRouter asks callers to identify themselves via HTTP-Referer / X-Title.
 */
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider.js';
import type { OpenAiCompatibleOptions } from './OpenAiCompatibleProvider.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';

export interface OpenRouterProviderOptions extends Partial<OpenAiCompatibleOptions> {
  /** Public URL of your deployment, shown in OpenRouter dashboards. */
  referer?: string;
  /** Human-readable app name shown in OpenRouter dashboards. */
  title?: string;
}

export class OpenRouterProvider extends OpenAiCompatibleProvider {
  constructor(options: OpenRouterProviderOptions = {}) {
    const { referer, title, extraHeaders, ...rest } = options;
    super({
      name: 'openrouter',
      ...rest,
      model: rest.model ?? OPENROUTER_DEFAULT_MODEL,
      baseUrl: rest.baseUrl ?? OPENROUTER_BASE_URL,
      apiKey: rest.apiKey ?? '',
      // OpenRouter identifies the caller through HTTP-Referer / X-Title.
      // Caller-supplied headers are merged in, never substituted for them -
      // otherwise the `referer` / `title` options would be silently dropped.
      extraHeaders: {
        ...(referer !== undefined ? { 'HTTP-Referer': referer } : {}),
        ...(title !== undefined ? { 'X-Title': title } : {}),
        ...extraHeaders,
      },
    });
  }
}