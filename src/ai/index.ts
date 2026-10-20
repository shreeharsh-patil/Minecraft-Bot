/** Public surface of the AI subsystem. */
export { AIManager } from './AIManager.js';
export type { AIManagerOptions, AIManagerStats, PlannerLike } from './AIManager.js';

export { AIRouter, AIUnavailableError } from './router.js';
export type { AIRouterOptions, RoutedResult } from './router.js';

export { Planner, parseActions, parseResponse, buildSystemPrompt, buildUserMessage } from './planner.js';
export type { PlanRequest, PlanResult, PlannerOptions } from './planner.js';

export { buildCompactContext, DEFAULT_CONTEXT_LIMITS } from './contextBuilder.js';
export type { CompactContext, ContextBuilderOptions, ContextLimits, WorldContextSource } from './contextBuilder.js';

export { InMemoryMemoryStore, createMemoryStore, MAX_CONVERSATION_TURNS } from './memory.js';
export type { MemoryStoreOptions } from './memory.js';

export { ProviderPool } from './providers/ProviderPool.js';
export type { ProviderPoolOptions } from './providers/ProviderPool.js';

export { BaseProvider, extractJson, stripCodeFences, extractBalancedJson } from './providers/BaseProvider.js';
export type { BaseProviderOptions, ProviderUsage, WireResult } from './providers/BaseProvider.js';
export { OpenAiCompatibleProvider } from './providers/OpenAiCompatibleProvider.js';
export type { OpenAiCompatibleOptions } from './providers/OpenAiCompatibleProvider.js';
export { OpenAIProvider, OPENAI_BASE_URL, OPENAI_DEFAULT_MODEL } from './providers/OpenAIProvider.js';
export { GroqProvider, GROQ_BASE_URL, GROQ_DEFAULT_MODEL } from './providers/GroqProvider.js';
export { OpenRouterProvider, OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODEL } from './providers/OpenRouterProvider.js';
export { GeminiProvider, GEMINI_BASE_URL, GEMINI_DEFAULT_MODEL } from './providers/GeminiProvider.js';