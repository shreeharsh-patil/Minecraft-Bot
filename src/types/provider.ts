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

/**
 * Kinds where retrying the SAME provider cannot plausibly succeed: the
 * request itself is wrong, the credentials were rejected, or the caller
 * cancelled the attempt.
 */
const NON_RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'invalid_request',
  'auth',
  'aborted',
]);

export class ProviderError extends Error {
  public readonly provider: ProviderName;
  /** Drives both fallback and circuit-breaker decisions. */
  public readonly kind: ProviderErrorKind;
  public readonly statusCode?: number;
  /**
   * True when retrying the same provider could plausibly succeed.
   *
   * Defaults to false for the kinds where a retry cannot help
   * (`invalid_request`, `auth`, `aborted`) and to true for every other
   * kind. An explicit `opts.retryable` always wins.
   */
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
    this.retryable = opts.retryable ?? !NON_RETRYABLE_KINDS.has(kind);
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

/** Circuit breaker state of one provider. */
export interface ProviderCircuit {
  readonly state: 'closed' | 'open' | 'half_open';
  /** When the circuit opened; null while it is closed. */
  readonly openedAt: number | null;
  /** When an open circuit may probe again; null unless it is open. */
  readonly until: number | null;
}

/**
 * Per-provider rolling health statistics used by the router.
 *
 * A snapshot, not a live view: the pool hands out copies, so every field
 * is read-only. Writing to one would silently change nothing.
 */
export interface ProviderStats {
  readonly name: ProviderName;
  readonly requests: number;
  readonly successes: number;
  readonly failures: number;
  readonly timeouts: number;
  readonly rateLimited: number;
  readonly consecutiveFailures: number;
  /** Exponential moving average of latency. */
  readonly avgLatencyMs: number;
  readonly lastLatencyMs: number | null;
  readonly lastUsedAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly available: boolean;
  /** Circuit breaker state. */
  readonly circuit: ProviderCircuit;
  readonly tier: ProviderTier;
}

export type { ProviderName };