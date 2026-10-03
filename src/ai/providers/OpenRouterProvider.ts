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
    const { referer, title, ...rest } = options;
    super({
      name: 'openrouter',
      model: OPENROUTER_DEFAULT_MODEL,
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: '',
      ...(referer !== undefined ? { extraHeaders: { 'HTTP-Referer': referer } } : {}),
      ...(title !== undefined
        ? { extraHeaders: { ...(referer !== undefined ? { 'HTTP-Referer': referer } : {}), 'X-Title': title } }
        : {}),
      ...rest,
    });
  }
}