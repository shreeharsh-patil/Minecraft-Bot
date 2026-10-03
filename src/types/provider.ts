/** AI provider abstraction. Provider-specific wire formats stay inside each adapter. */
import type { ProviderName } from '../config/constants.js';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: AiMessage[];
  /** Ask the provider for a JSON object matching the action schema. */
  jsonMode: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Hard ceiling; the provider must abort the request at this point. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  /** Wall-clock latency in ms - the router's main ranking signal. */
  latencyMs: number;
  model: string;
  /** Token usage when the provider reports it. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export class ProviderError extends Error {
  public readonly provider: ProviderName;
  /** Drives both fallback and circuit-breaker decisions. */
  public readonly kind: ProviderErrorKind;
  public readonly statusCode?: number;
  /** True when retrying the same provider could plausibly succeed. */
  public readonly retryable: boolean;

  constructor(
    provider: ProviderName,
    kind: ProviderErrorKind,
    message: string,
    opts: { statusCode?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.statusCode = opts.statusCode;
    this.retryable = opts.retryable ?? kind !== 'invalid_request';
  }
}

export type ProviderErrorKind =
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'invalid_request'
  | 'server_error'
  | 'aborted'
  | 'parse_error'
  | 'unknown';

/** Every adapter implements this. Nothing above this layer knows provider specifics. */
export interface AiProvider {
  readonly name: ProviderName;
  readonly model: string;
  /** False when the key is missing or the provider is administratively disabled. */
  isAvailable(): boolean;
  /** Cheap pre-flight so the router does not select a dead provider. */
  healthCheck(): Promise<boolean>;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** Release sockets/abort in-flight work on shutdown. */
  dispose(): void | Promise<void>;
}

export type ProviderTier = 'fast' | 'planning';

/** Per-provider rolling health statistics used by the router. */
export interface ProviderStats {
  readonly name: ProviderName;
  requests: number;
  successes: number;
  failures: number;
  timeouts: number;
  rateLimited: number;
  consecutiveFailures: number;
  /** Exponential moving average of latency. */
  avgLatencyMs: number;
  lastLatencyMs: number | null;
  lastUsedAt: number | null;
  lastSuccessAt: number | null;
  available: boolean;
  /** Circuit breaker state. */
  circuit: { state: 'closed' | 'open' | 'half_open'; openedAt: number | null; until: number | null };
  tier: ProviderTier;
}

export type { ProviderName };