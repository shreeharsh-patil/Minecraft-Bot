/** OpenAI Chat Completions. Endpoint: https://api.openai.com/v1/chat/completions */
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider.js';
import type { OpenAiCompatibleOptions } from './OpenAiCompatibleProvider.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

export class OpenAIProvider extends OpenAiCompatibleProvider {
  constructor(options: Partial<OpenAiCompatibleOptions> = {}) {
    super({
      name: 'openai',
      model: OPENAI_DEFAULT_MODEL,
      baseUrl: OPENAI_BASE_URL,
      apiKey: '',
      ...options,
    });
  }
}