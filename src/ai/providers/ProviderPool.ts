/**
 * Provider registry + health bookkeeping.
 *
 * Owns everything the router needs to decide *which* provider to use and
 * *whether it can be trusted right now*:
 *  - per-provider rolling stats with an exponential moving average latency;
 *  - a circuit breaker: closed -> open (after N consecutive failures) ->
 *    half_open (after the cooldown, allowing one probe) -> closed on success.
 *
 * The pool never performs I/O itself; `register` also accepts providers that are
 * unavailable (no key), which are simply skipped by `getAvailable`.
 */
import type {
  AiProvider,
  ProviderError,
  ProviderErrorKind,
  ProviderName,
  ProviderStats,
  ProviderTier,
} from '../../types/provider.js';
import { silentLogger } from '../../utils/logger.js';
import type { Logger } from '../../utils/logger.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

/** Mutable mirror of ProviderStats; the pool owns the canonical copy. */
interface MutableCircuit {
  state: CircuitState;
  openedAt: number | null;
  until: number | null;
}

interface MutableStats {
  name: ProviderName;
  requests: number;
  successes: number;
  failures: number;
  timeouts: number;
  rateLimited: number;
  consecutiveFailures: number;
  avgLatencyMs: number;
  lastLatencyMs: number | null;
  lastUsedAt: number | null;
  lastSuccessAt: number | null;
  available: boolean;
  circuit: MutableCircuit;
  tier: ProviderTier;
}

export interface ProviderPoolOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before a probe is allowed. */
  cooldownMs: number;
  /** EMA smoothing factor for latency (0..1]. */
  emaAlpha?: number;
  logger?: Logger;
  /** Injected clock, so tests can drive the cooldown deterministically. */
  now?: () => number;
}

interface Entry {
  provider: AiProvider;
  tier: ProviderTier;
  stats: MutableStats;
}

function freshStats(name: ProviderName, tier: ProviderTier, available: boolean): MutableStats {
  return {
    name,
    requests: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    rateLimited: 0,
    consecutiveFailures: 0,
    avgLatencyMs: 0,
    lastLatencyMs: null,
    lastUsedAt: null,
    lastSuccessAt: null,
    available,
    circuit: { state: 'closed', openedAt: null, until: null },
    tier,
  };
}

/** Deep-ish copy so callers cannot mutate the pool's internals. */
function snapshotStats(stats: MutableStats): ProviderStats {
  return {
    name: stats.name,
    requests: stats.requests,
    successes: stats.successes,
    failures: stats.failures,
    timeouts: stats.timeouts,
    rateLimited: stats.rateLimited,
    consecutiveFailures: stats.consecutiveFailures,
    avgLatencyMs: stats.avgLatencyMs,
    lastLatencyMs: stats.lastLatencyMs,
    lastUsedAt: stats.lastUsedAt,
    lastSuccessAt: stats.lastSuccessAt,
    available: stats.available,
    circuit: { ...stats.circuit },
    tier: stats.tier,
  };
}

export class ProviderPool {
  private readonly entries = new Map<ProviderName, Entry>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly emaAlpha: number;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: ProviderPoolOptions) {
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold));
    this.cooldownMs = Math.max(1, Math.floor(options.cooldownMs));
    this.emaAlpha = Math.min(1, Math.max(0.01, options.emaAlpha ?? 0.3));
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => Date.now());
  }

  /** Adds (or replaces) a provider. The tier is the router's preference hint. */
  public register(provider: AiProvider, tier: ProviderTier = 'fast'): void {
    const existing = this.entries.get(provider.name);
    if (existing) {
      existing.provider = provider;
      existing.tier = tier;
      existing.stats.tier = tier;
      existing.stats.available = provider.isAvailable();
      return;
    }
    this.entries.set(provider.name, {
      provider,
      tier,
      stats: freshStats(provider.name, tier, provider.isAvailable()),
    });
    this.logger.debug('provider registered', { provider: provider.name, tier });
  }

  public get(name: ProviderName): AiProvider | undefined {
    return this.entries.get(name)?.provider;
  }

  public has(name: ProviderName): boolean {
    return this.entries.has(name);
  }

  /** All registered providers, in registration (preference) order. */
  public all(): AiProvider[] {
    return [...this.entries.values()].map((entry) => entry.provider);
  }

  /**
   * Providers eligible right now: has a key, and its circuit is not `open`.
   * An `open` circuit whose cooldown has elapsed is transitioned to `half_open`
   * here, which makes exactly one probe eligible.
   */
  public getAvailable(tier?: ProviderTier): AiProvider[] {
    const now = this.now();
    const out: AiProvider[] = [];
    for (const entry of this.entries.values()) {
      if (tier !== undefined && entry.tier !== tier) continue;
      if (!entry.provider.isAvailable()) {
        entry.stats.available = false;
        continue;
      }
      entry.stats.available = true;
      this.refreshCircuit(entry, now);
      if (entry.stats.circuit.state === 'open') continue;
      out.push(entry.provider);
    }
    return out;
  }

  /** Current circuit state, applying any pending cooldown transition. */
  public circuitState(name: ProviderName): CircuitState | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    this.refreshCircuit(entry, this.now());
    return entry.stats.circuit.state;
  }

  /** Records a success: closes the circuit and folds latency into the EMA. */
  public recordSuccess(name: ProviderName, latencyMs: number): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    const stats = entry.stats;
    stats.requests += 1;
    stats.successes += 1;
    stats.consecutiveFailures = 0;
    stats.lastUsedAt = this.now();
    stats.lastSuccessAt = stats.lastUsedAt;
    stats.lastLatencyMs = latencyMs;
    stats.avgLatencyMs = stats.avgLatencyMs === 0 ? latencyMs : this.ema(stats.avgLatencyMs, latencyMs);

    if (stats.circuit.state !== 'closed') {
      this.logger.info('circuit closed', { provider: name, previous: stats.circuit.state });
    }
    stats.circuit = { state: 'closed', openedAt: null, until: null };
  }

  /** Records a failure and opens the circuit once the threshold is reached. */
  public recordFailure(name: ProviderName, error?: ProviderError): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    const stats = entry.stats;
    stats.requests += 1;
    stats.failures += 1;
    stats.consecutiveFailures += 1;
    stats.lastUsedAt = this.now();

    const kind: ProviderErrorKind = error?.kind ?? 'unknown';
    if (kind === 'timeout') stats.timeouts += 1;
    if (kind === 'rate_limited') stats.rateLimited += 1;

    if (stats.consecutiveFailures >= this.failureThreshold) {
      const now = this.now();
      stats.circuit = { state: 'open', openedAt: now, until: now + this.cooldownMs };
      this.logger.warn('circuit opened', {
        provider: name,
        consecutiveFailures: stats.consecutiveFailures,
        cooldownMs: this.cooldownMs,
        kind,
      });
    }
  }

/** Rolling view of every provider's health. Copies, not live references. */
  public stats(): ProviderStats[] {
    const now = this.now();
    return [...this.entries.values()].map((entry) => {
      this.refreshCircuit(entry, now);
      return snapshotStats(entry.stats);
    });
  }

  /** Convenience for status commands: one provider's stats, or undefined. */
  public statsFor(name: ProviderName): ProviderStats | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    this.refreshCircuit(entry, this.now());
    return snapshotStats(entry.stats);
  }

  /** Disposes every provider; safe to call more than once. */
  public async disposeAll(): Promise<void> {
    const providers = [...this.entries.values()].map((entry) => entry.provider);
    // `dispose()` may return void or a promise; normalise before aggregating.
    const results = await Promise.allSettled(providers.map((provider) => Promise.resolve(provider.dispose())));
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn('provider dispose failed', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
    this.entries.clear();
  }

  /**
   * Applies the open -> half_open transition once the cooldown has elapsed.
   * A half_open provider is selectable; the next success closes the circuit and
   * the next failure re-opens it for another cooldown.
   */
  private refreshCircuit(entry: Entry, now: number): void {
    const circuit = entry.stats.circuit;
    if (circuit.state !== 'open') return;
    if (circuit.until !== null && now >= circuit.until) {
      entry.stats.circuit = { state: 'half_open', openedAt: circuit.openedAt, until: null };
      this.logger.info('circuit half-open, probing', { provider: entry.provider.name });
    }
  }

  private ema(previous: number, sample: number): number {
    return this.emaAlpha * sample + (1 - this.emaAlpha) * previous;
  }
}