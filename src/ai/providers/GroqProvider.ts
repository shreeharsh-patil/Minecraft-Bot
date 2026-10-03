/**
 * Groq. OpenAI-compatible.
 * Endpoint: https://api.groq.com/openai/v1/chat/completions
 * Groq is very fast, so it is normally registered as the `fast` tier default.
 */
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider.js';
import type { OpenAiCompatibleOptions } from './OpenAiCompatibleProvider.js';
import type { ProviderTier } from '../../types/provider.js';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';

export interface GroqProviderOptions extends Partial<OpenAiCompatibleOptions> {
  tier?: ProviderTier;
}

export class GroqProvider extends OpenAiCompatibleProvider {
  constructor(options: GroqProviderOptions = {}) {
    super({
      name: 'groq',
      model: GROQ_DEFAULT_MODEL,
      baseUrl: GROQ_BASE_URL,
      apiKey: '',
      tier: 'fast',
      ...options,
    });
  }
}