/**
 * Provider selection with automatic fallback.
 *
 * Ranking:
 *  - `fast` tier   -> lowest EMA latency among healthy providers;
 *  - `planning`    -> providers explicitly registered as planning-tier first,
 *                     then the one configured as `ai.planningModel`, then the
 *                     slowest (i.e. strongest) healthy provider.
 *
 * Both tiers skip providers whose circuit is `open`, and both respect the
 * overall request deadline (`ai.requestTimeoutMs`): a failing AI API can never
 * hang the bot, however many providers are configured.
 */
import { ProviderError } from '../types/provider.js';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  ProviderErrorKind,
  ProviderName,
  ProviderStats,
  ProviderTier,
} from '../types/provider.js';
import { ProviderPool } from './providers/ProviderPool.js';
import type { ProviderPoolOptions } from './providers/ProviderPool.js';
import { silentLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

export interface AIRouterOptions extends ProviderPoolOptions {
  /** Hard ceiling for a whole fallback chain. */
  requestTimeoutMs: number;
  /** Model preferred for `planning`-tier requests, if configured. */
  planningModel?: string;
}

export interface RoutedResult extends CompletionResult {
  /** Which provider actually answered. */
  provider: ProviderName;
  /** How many providers were tried (1 = first choice worked). */
  attempts: number;
}

export class AIUnavailableError extends Error {
  public readonly failures: ReadonlyArray<{ provider: ProviderName; kind: ProviderErrorKind; message: string }>;

  constructor(message: string, failures: ReadonlyArray<{ provider: ProviderName; kind: ProviderErrorKind; message: string }> = []) {
    super(message);
    this.name = 'AIUnavailableError';
    this.failures = failures;
  }
}

/**
 * Only a caller abort stops the chain immediately. Every other failure -
 * including a bad API key - falls through to the next provider, because the
 * problem is provider-specific (a wrong OpenAI key must not disable Groq).
 * Non-retryable errors are still not retried against the *same* provider,
 * since each candidate is tried at most once per request.
 *
 * The `aborted` kind is reserved for a request the CALLER cancelled: it is
 * produced only when the caller's signal is aborted (see `toProviderError`).
 * A provider that aborts on its own is a provider fault and never terminal.
 */
const TERMINAL_KINDS: ReadonlySet<ProviderErrorKind> = new Set(['aborted']);

/** Kept back from each attempt so the remaining providers still get a turn. */
const MIN_FALLBACK_RESERVE_MS = 250;
export class AIRouter {
  public readonly pool: ProviderPool;

  private readonly requestTimeoutMs: number;
  private readonly planningModel: string | undefined;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: AIRouterOptions) {
    const { requestTimeoutMs, planningModel, ...poolOptions } = options;
    this.pool = new ProviderPool(poolOptions);
    this.requestTimeoutMs = Math.max(100, Math.floor(requestTimeoutMs));
    this.planningModel = planningModel;
    this.logger = poolOptions.logger ?? silentLogger;
    this.now = poolOptions.now ?? (() => Date.now());
  }

  /**
   * Runs `request` against the ranked providers until one succeeds or the
   * deadline passes. Never throws a non-ProviderError, and never exceeds the
   * configured deadline by more than the final in-flight request's own abort.
   */
  public async complete(request: CompletionRequest, tier: ProviderTier = 'fast'): Promise<RoutedResult> {
    const deadline = this.now() + Math.min(this.requestTimeoutMs, Math.max(1, request.timeoutMs));
    const candidates = this.rank(tier);

    if (candidates.length === 0) {
      throw new AIUnavailableError('No available AI provider');
    }

    const failures: Array<{ provider: ProviderName; kind: ProviderErrorKind; message: string }> = [];

    for (const [index, provider] of candidates.entries()) {
      if (this.now() >= deadline) {
        this.logger.warn('request deadline reached before a provider could answer', {
          tier,
          attempted: index,
          deadlineMs: Math.min(this.requestTimeoutMs, Math.max(1, request.timeoutMs)),
        });
        break;
      }

      const attemptStarted = this.now();
      const budgetMs = this.attemptBudget(deadline - this.now(), candidates.length - index);
      try {
        const result = await this.runAttempt(provider, { ...request, timeoutMs: budgetMs }, budgetMs);
        this.pool.recordSuccess(provider.name, result.latencyMs);
        if (index > 0) {
          this.logger.info('provider fallback succeeded', {
            provider: provider.name,
            attempts: index + 1,
            tier,
          });
        }
        return { ...result, provider: provider.name, attempts: index + 1 };
      } catch (error) {
        // The caller's signal - not the shape of the error - decides whether
        // this attempt is terminal: only a cancelled request (`!stop`) stops
        // the chain. A provider that aborts on its own is a provider fault
        // and falls through to the next candidate.
        const providerError = this.toProviderError(error, provider, request.signal?.aborted === true);
        const terminal = TERMINAL_KINDS.has(providerError.kind);
        // A user-initiated abort is NOT the provider's fault. Charging it to
        // the provider's failure counters would open the circuit breaker on a
        // perfectly healthy provider after three `!stop`s.
        if (!terminal) this.pool.recordFailure(provider.name, providerError);
        failures.push({
          provider: provider.name,
          kind: providerError.kind,
          message: providerError.message,
        });
        this.logger.warn(
          terminal ? 'provider attempt aborted by the caller' : 'provider attempt failed, falling back',
          {
            provider: provider.name,
            kind: providerError.kind,
            statusCode: providerError.statusCode,
            elapsedMs: this.now() - attemptStarted,
            charged: !terminal,
            next: candidates[index + 1]?.name ?? 'none',
          },
        );

        // An abort means the user pressed !stop - do not burn the other providers.
        if (terminal) throw providerError;
      }
    }

    throw new AIUnavailableError(
      `All AI providers failed (${failures.map((f) => `${f.provider}:${f.kind}`).join(', ')})`,
      failures,
    );
  }

/**
   * Runs one attempt under the attempt budget.
   *
   * The provider is asked to abort at `budgetMs`, but a provider that ignores
   * (or outlives) its deadline would eat the whole request budget and leave
   * the fallback with nothing - exactly the case the fallback chain exists
   * for. The router therefore enforces the budget itself: when it expires the
   * attempt is abandoned, the provider is charged with a timeout and the next
   * candidate gets its turn.
   */
  private async runAttempt(
    provider: AiProvider,
    request: CompletionRequest,
    budgetMs: number,
  ): Promise<CompletionResult> {
    // The provider is started first so that its own timeout timer is armed
    // before the router's watchdog: the provider's own error then wins the
    // race and the watchdog only catches providers that never answer.
    const attempt = provider.complete(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new ProviderError(provider.name, 'timeout', `${provider.name}: attempt exceeded ${budgetMs}ms`, {
            retryable: true,
          }),
        );
      }, budgetMs);
      timer.unref();
    });
    try {
      return await Promise.race([attempt, expiry]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

/**
   * How long a single attempt may take.
   *
   * The remaining time is split FAIRLY between the candidates that are still
   * left: every attempt gets its own share, so a provider that hangs (the
   * exact case the fallback exists for) cannot eat the whole deadline and
   * leave the fallback with a few hundred milliseconds. A small reserve is
   * still kept back for the candidates after this one, so the chain always
   * has a turn left.
   */
  private attemptBudget(remainingMs: number, candidatesLeft: number): number {
    const remaining = Math.max(1, remainingMs);
    if (candidatesLeft <= 1) return remaining;
    // This attempt's fair share of what is left.
    const share = Math.ceil(remaining / candidatesLeft);
    // The reserve the candidates after this one need - never more than half
    // of the remaining time, so even a tiny deadline leaves every candidate
    // a turn.
    const reserve = Math.min(MIN_FALLBACK_RESERVE_MS, Math.floor(remaining / 2));
    // The share, but never so much that the reserve is eaten.
    return Math.max(1, Math.min(share, remaining - reserve));
  }

  /**
   * Ordered candidate list for a tier. Healthy providers only (`getAvailable`
   * already drops unavailable ones and skips `open` circuits).
   *
   * The list is the fallback order too, so provider A is always tried before B.
   */
  public rank(tier: ProviderTier): AiProvider[] {
    const available = this.pool.getAvailable(tier);
    const statsByName = new Map(this.pool.stats().map((s) => [s.name, s] as const));

    return [...available].sort((a, b) => this.compare(a, b, tier, statsByName));
  }

  /** Lower sorts first. */
  private compare(
    a: AiProvider,
    b: AiProvider,
    tier: ProviderTier,
    stats: ReadonlyMap<ProviderName, ProviderStats>,
  ): number {
    const aStats = stats.get(a.name);
    const bStats = stats.get(b.name);
    if (!aStats || !bStats) return 0;

    // A half-open (probing) provider competes on normal terms; only an open
    // circuit would exclude it, and that is handled by getAvailable().
    if (tier === 'planning') {
      const aPlanning = aStats.tier === 'planning' ? 0 : 1;
      const bPlanning = bStats.tier === 'planning' ? 0 : 1;
      if (aPlanning !== bPlanning) return aPlanning - bPlanning;

      const aIsPlanningModel = this.planningModel !== undefined && a.model === this.planningModel;
      const bIsPlanningModel = this.planningModel !== undefined && b.model === this.planningModel;
      if (aIsPlanningModel !== bIsPlanningModel) return aIsPlanningModel ? -1 : 1;

      // Planning prefers the stronger (usually slower) model: rank by
      // descending EMA latency among providers we have actually measured.
      const aLatency = aStats.avgLatencyMs;
      const bLatency = bStats.avgLatencyMs;
      if (aLatency > 0 && bLatency > 0 && aLatency !== bLatency) return bLatency - aLatency;
      if ((aLatency > 0) !== (bLatency > 0)) return aLatency > 0 ? -1 : 1;
      return 0;
    }

    // `fast` tier: lowest EMA latency wins. A provider we have never measured
    // sorts FIRST rather than last: it gets one real request to earn a latency
    // sample instead of being starved forever by an unmeasured zero.
    const aLatency = aStats.avgLatencyMs;
    const bLatency = bStats.avgLatencyMs;
    const aMeasured = aLatency > 0;
    const bMeasured = bLatency > 0;
    if (aMeasured !== bMeasured) return aMeasured ? 1 : -1;
    if (aMeasured && aLatency !== bLatency) return aLatency - bLatency;
    return 0;
  }

  /**
   * Normalises anything a provider throws into a ProviderError.
   *
   * The caller's signal decides WHY the request ended, not the shape of the
   * error: only a cancelled request becomes the terminal `aborted` kind. A
   * provider that aborts on its own (its own timeout, a dropped socket) is a
   * provider fault - it must fall through to the next candidate instead of
   * ending the chain.
   */
  private toProviderError(error: unknown, provider: AiProvider, callerAborted: boolean): ProviderError {
    if (error instanceof ProviderError) {
      if (callerAborted) {
        // The request was cancelled: whatever the provider called the error,
        // the failure belongs to the caller, not to the provider.
        return new ProviderError(provider.name, 'aborted', error.message, {
          statusCode: error.statusCode,
          retryable: false,
          cause: error,
        });
      }
      if (error.kind === 'aborted') {
        // The provider aborted by itself: a provider fault, not a cancelled
        // request, so it must not stop the chain.
        return new ProviderError(provider.name, 'unknown', error.message, {
          statusCode: error.statusCode,
          cause: error,
        });
      }
      return error;
    }
    if (isAbortError(error)) {
      return new ProviderError(
        provider.name,
        callerAborted ? 'aborted' : 'unknown',
        `${provider.name}: request aborted`,
        {
          cause: error,
          retryable: false,
        },
      );
    }
    return new ProviderError(provider.name, 'unknown', `${provider.name}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'AbortedError');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}