/**
 * Shared provider plumbing.
 *
 * Every adapter (OpenAI, Groq, OpenRouter, Gemini) inherits exactly one
 * timeout/abort story, one error taxonomy and one JSON extractor from here, so
 * no provider-specific detail ever leaks above this layer.
 *
 * Hard rule: this file must never log the API key - not in headers, not in the
 * URL (Gemini puts the key in the query string), not in the request body.
 */
import { ProviderError } from '../../types/provider.js';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  ProviderName,
  ProviderTier,
} from '../../types/provider.js';
import { silentLogger } from '../../utils/logger.js';
import type { Logger } from '../../utils/logger.js';
import { scrubText } from '../../utils/redact.js';

/** Normalised, provider-agnostic token usage. */
export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** What an adapter lifts out of its provider's response payload. */
export interface WireResult {
  text: string;
  model?: string;
  usage?: ProviderUsage;
}

export interface BaseProviderOptions {
  name: ProviderName;
  apiKey: string;
  model: string;
  logger?: Logger;
  /** Router preference hint; the router may still cross tiers on fallback. */
  tier?: ProviderTier;
  baseUrl?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional cheap liveness probe. Default: "do we have an API key?". */
  healthProbe?: () => Promise<boolean>;
}

interface TransportContext {
  timedOut: boolean;
  externallyAborted: boolean;
  timeoutMs: number;
}

/**
 * The largest delay `setTimeout` can represent (2^31-1 ms).
 *
 * Node silently rewrites anything larger into 1ms, which would abort every
 * request immediately instead of waiting for it.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Clamps a caller-supplied timeout into a range the platform timer honours.
 *
 * `Infinity` (and every value the timer cannot hold) means "no deadline" -
 * the planner uses `Number.MAX_SAFE_INTEGER` for exactly that - and is mapped
 * onto the timer maximum. Handing it to `setTimeout` unchanged would fire the
 * abort after 1ms and fail every request as a timeout.
 *
 * `NaN` is not a deadline at all but a caller bug: it keeps failing fast
 * instead of turning into a request that never ends.
 */
function toTimerMs(value: number): number {
  if (value === Infinity) return MAX_TIMER_MS;
  if (Number.isNaN(value)) return 1;
  return Math.max(1, Math.min(MAX_TIMER_MS, Math.floor(value)));
}

/** Network-level failure codes worth naming rather than lumping into `unknown`. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Narrows unknown JSON to a plain object without `any`. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Pulls a `{ prompt, completion, total }` usage block out of a provider payload.
 * Returns undefined when the provider reported nothing usable.
 */
export function readUsage(source: Record<string, unknown> | undefined): ProviderUsage | undefined {
  if (!source) return undefined;
  const promptTokens = asNumber(
    source['promptTokens'] ?? source['prompt_token_count'] ?? source['promptTokenCount'],
  );
  const completionTokens = asNumber(
    source['completionTokens'] ?? source['completion_token_count'] ?? source['candidatesTokenCount'],
  );
  const totalTokens = asNumber(source['totalTokens'] ?? source['total_token_count'] ?? source['totalTokenCount']);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

export abstract class BaseProvider implements AiProvider {
  public readonly name: ProviderName;
  public readonly model: string;
  public readonly tier: ProviderTier;

  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  protected readonly logger: Logger;
  protected readonly fetchImpl: typeof fetch;

  private readonly healthProbe: (() => Promise<boolean>) | undefined;

  constructor(options: BaseProviderOptions) {
    this.name = options.name;
    this.model = options.model;
    this.tier = options.tier ?? 'fast';
    this.apiKey = options.apiKey ?? '';
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.healthProbe = options.healthProbe;
  }

  /** False when there is no key - the cheapest possible dead-provider check. */
  public isAvailable(): boolean {
    return this.apiKey.trim().length > 0;
  }

  /** Pre-flight for the router. Never throws; never spends real tokens. */
  public async healthCheck(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    if (!this.healthProbe) return true;
    try {
      return await this.healthProbe();
    } catch (error) {
      this.logger.warn('provider health probe failed', {
        provider: this.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Adapters holding sockets override this. */
  public dispose(): void {
    /* nothing to release by default */
  }

  // --- provider-specific surface ---------------------------------------------

  /** Absolute URL for the completion call. Never logged verbatim (key in query). */
  protected abstract endpoint(): string;

  /** Request headers. Values are never logged. */
  protected abstract headers(): Record<string, string>;

  /** JSON body for the completion call. */
  protected abstract payload(request: CompletionRequest): unknown;

  /** Extracts text/model/usage from a decoded provider response. */
  protected abstract readResult(payload: unknown): WireResult;

// --- shared machinery ---------------------------------------------------------

  public async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.isAvailable()) {
      throw new ProviderError(this.name, 'auth', `${this.name}: no API key configured`, { retryable: false });
    }

    const timeoutMs = toTimerMs(request.timeoutMs);
    const controller = new AbortController();
    const timeoutState = { timedOut: false };
    const timer = setTimeout(() => {
      timeoutState.timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref();

    const external = request.signal;
    const forwardAbort = (): void => {
      controller.abort();
    };
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', forwardAbort, { once: true });
    }

    const startedAt = Date.now();
    try {
      this.logger.debug('provider request', {
        provider: this.name,
        model: this.model,
        // `safeUrl` strips the query string so a Gemini ?key= can never be logged.
        url: safeUrl(this.endpoint()),
        timeoutMs,
      });

      const response = await this.callApi(controller.signal, request, timeoutMs, timeoutState, external);

      let raw: string;
      try {
        raw = await response.text();
      } catch (error) {
        throw this.transportError(error, {
          timedOut: timeoutState.timedOut,
          externallyAborted: external?.aborted === true,
          timeoutMs,
        });
      }

      if (!response.ok) throw this.httpError(response.status, raw);

      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch (error) {
        throw new ProviderError(this.name, 'parse_error', `${this.name}: response body was not JSON`, {
          statusCode: response.status,
          cause: error,
        });
      }

      let wire: WireResult;
      try {
        wire = this.readResult(decoded);
      } catch (error) {
        // An adapter may throw here - an OpenAI-compatible host can answer
        // 200 with an error envelope. The taxonomy is this layer's contract:
        // a raw error must never leak above it.
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(this.name, 'unknown', `${this.name}: ${scrubText(errorMessage(error))}`, {
          cause: error,
        });
      }
      if (wire.text.trim().length === 0) {
        throw new ProviderError(this.name, 'parse_error', `${this.name}: model returned no text`, {
          retryable: false,
        });
      }

      const latencyMs = Date.now() - startedAt;
      this.logger.debug('provider response', {
        provider: this.name,
        status: response.status,
        latencyMs,
        chars: wire.text.length,
      });
      return {
        text: wire.text,
        model: wire.model ?? this.model,
        latencyMs,
        ...(wire.usage ? { usage: wire.usage } : {}),
      };
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', forwardAbort);
    }
  }

  private async callApi(
    signal: AbortSignal,
    request: CompletionRequest,
    timeoutMs: number,
    timeoutState: { timedOut: boolean },
    external: AbortSignal | undefined,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(this.endpoint(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.payload(request)),
        signal,
      });
    } catch (error) {
      throw this.transportError(error, {
        timedOut: timeoutState.timedOut,
        externallyAborted: external?.aborted === true,
        timeoutMs,
      });
    }
  }

/** Maps a thrown transport error onto the shared ProviderError taxonomy. */
  protected transportError(error: unknown, ctx: TransportContext): ProviderError {
    if (error instanceof ProviderError) return error;

    if (ctx.timedOut) {
      return new ProviderError(this.name, 'timeout', `${this.name}: request exceeded ${ctx.timeoutMs}ms`, {
        cause: error,
        retryable: true,
      });
    }
    if (ctx.externallyAborted) {
      return new ProviderError(this.name, 'aborted', `${this.name}: request cancelled by caller`, {
        cause: error,
        retryable: false,
      });
    }

    const name = errorName(error);
    if (name === 'AbortError' || name === 'TimeoutError') {
      return new ProviderError(this.name, 'timeout', `${this.name}: request aborted`, { cause: error });
    }

    const code = errorCode(error);
    if (code !== undefined && NETWORK_CODES.has(code)) {
      return new ProviderError(this.name, 'network', `${this.name}: network failure (${code})`, { cause: error });
    }
    if (error instanceof TypeError) {
      // `fetch` rejects with TypeError for DNS/TLS/socket problems.
      return new ProviderError(this.name, 'network', `${this.name}: network failure`, { cause: error });
    }
    return new ProviderError(this.name, 'unknown', `${this.name}: ${scrubText(errorMessage(error))}`, {
      cause: error,
    });
  }

  /** Maps an HTTP status onto the shared ProviderError taxonomy. */
  protected httpError(status: number, rawBody: string): ProviderError {
    const detail = this.summarizeErrorBody(rawBody);
    if (status === 429) {
      return new ProviderError(this.name, 'rate_limited', `${this.name}: rate limited${detail}`, {
        statusCode: status,
        retryable: true,
      });
    }
    if (status === 401 || status === 403) {
      return new ProviderError(this.name, 'auth', `${this.name}: credentials rejected${detail}`, {
        statusCode: status,
        retryable: false,
      });
    }
    if (status === 408 || status === 504) {
      return new ProviderError(this.name, 'timeout', `${this.name}: upstream timeout (${status})${detail}`, {
        statusCode: status,
        retryable: true,
      });
    }
    if (status === 404) {
      // Unknown model / wrong URL for this provider - retrying cannot help.
      return new ProviderError(this.name, 'invalid_request', `${this.name}: not found (${status})${detail}`, {
        statusCode: status,
        retryable: false,
      });
    }
    if (status >= 500) {
      return new ProviderError(this.name, 'server_error', `${this.name}: server error (${status})${detail}`, {
        statusCode: status,
        retryable: true,
      });
    }
    if (status >= 400) {
      return new ProviderError(this.name, 'invalid_request', `${this.name}: bad request (${status})${detail}`, {
        statusCode: status,
        retryable: false,
      });
    }
    return new ProviderError(this.name, 'unknown', `${this.name}: unexpected status ${status}${detail}`, {
      statusCode: status,
    });
  }

  /** Best-effort, scrubbed and truncated error text for logs and chat. */
  protected summarizeErrorBody(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return '';
    let message: string | undefined;
    try {
      const root = asRecord(JSON.parse(trimmed) as unknown);
      const nested = asRecord(root?.['error']);
      message = asString(nested?.['message']) ?? asString(root?.['message']);
    } catch {
      message = undefined;
    }
    const scrubbed = scrubText(message ?? trimmed).replace(/\s+/g, ' ').trim();
    if (scrubbed.length === 0) return '';
    return scrubbed.length > 240 ? ` - ${scrubbed.slice(0, 240)}` : ` - ${scrubbed}`;
  }
}

// --- helpers -------------------------------------------------------------------

export function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Pulls an errno-style code out of a fetch/DNS error without `any`. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const nested = (cause as { code?: unknown }).code;
    if (typeof nested === 'string') return nested;
  }
  return undefined;
}

/** URL safe to log: origin + path only, query string dropped (Gemini keys live there). */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}
// --- JSON extraction -----------------------------------------------------------

/**
 * Model output is not JSON: it arrives wrapped in ```json fences, prefixed with
 * "Sure! Here you go:", or trailing commentary. These helpers recover the JSON
 * payload without ever `eval`-ing anything.
 */
const FENCE_RE = /```(?:json|jsonc|json5)?\s*([\s\S]*?)```/gi;

/** Strips ``` fences and returns the fenced bodies plus the bare remainder. */
export function stripCodeFences(text: string): string[] {
  const candidates: string[] = [];
  FENCE_RE.lastIndex = 0;
  let match = FENCE_RE.exec(text);
  while (match !== null) {
    const body = match[1];
    if (body && body.trim().length > 0) candidates.push(body.trim());
    match = FENCE_RE.exec(text);
  }
  const withoutFences = text.replace(FENCE_RE, ' ').trim();
  if (withoutFences.length > 0) candidates.push(withoutFences);
  return candidates;
}

/**
 * Finds the first balanced `{...}` or `[...]` region in `text`, respecting
 * string literals and escapes. Returns undefined when there is none.
 */
export function extractBalancedJson(text: string): string | undefined {
  const startIndices: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{' || ch === '[') startIndices.push(i);
  }

  for (const start of startIndices) {
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i] ?? '';
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

/**
 * Best-effort JSON decode of model prose. Tries, in order: the whole string,
 * each code-fence body, and the first balanced object/array.
 * Returns undefined rather than throwing - callers decide how to react.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    /* fall through to the recovery strategies */
  }

  for (const candidate of stripCodeFences(trimmed)) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      const balanced = extractBalancedJson(candidate);
      if (balanced !== undefined) {
        try {
          return JSON.parse(balanced) as unknown;
        } catch {
          /* keep trying the next candidate */
        }
      }
    }
  }

  const balanced = extractBalancedJson(trimmed);
  if (balanced !== undefined) {
    try {
      return JSON.parse(balanced) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}