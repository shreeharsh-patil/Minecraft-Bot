/**
 * Provider registry + health bookkeeping.
 *
 * Owns everything the router needs to decide *which* provider to use and
 * *whether it can be trusted right now*:
 *  - per-provider rolling stats with an exponential moving average latency;
 *  - a circuit breaker: closed -> open (after N consecutive failures) ->
 *    half_open (after the cooldown, allowing one probe) -> closed on success;
 *  - the cached `AiProvider.healthCheck()` verdict: a provider whose probe
 *    failed is skipped, and the probe runs in the background so the request
 *    path never waits for it.
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
  /** How long a health verdict stays authoritative before it is refreshed. */
  healthTtlMs?: number;
  logger?: Logger;
  /** Injected clock, so tests can drive the cooldown deterministically. */
  now?: () => number;
}

interface Entry {
  provider: AiProvider;
  tier: ProviderTier;
  stats: MutableStats;
  /** True while a half-open circuit probe is in flight. */
  probeInFlight: boolean;
  /** When the in-flight half-open probe was handed out (null when none). */
  probeAt: number | null;
  /** Last health verdict, or null when the provider was never probed. */
  health: HealthVerdict | null;
  /** The background health probe currently running, if any. */
  healthProbe: Promise<boolean> | null;
}

/** The cached outcome of one `AiProvider.healthCheck()` probe. */
interface HealthVerdict {
  ok: boolean;
  checkedAt: number;
}

/** How long a health verdict is trusted before a fresh probe is scheduled. */
const DEFAULT_HEALTH_TTL_MS = 60_000;

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
  private readonly healthTtlMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: ProviderPoolOptions) {
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold));
    this.cooldownMs = Math.max(1, Math.floor(options.cooldownMs));
    this.emaAlpha = Math.min(1, Math.max(0.01, options.emaAlpha ?? 0.3));
    this.healthTtlMs = Math.max(1_000, Math.floor(options.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS));
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
      // A replaced provider gets a fresh verdict; the old one says nothing
      // about the new key or base URL.
      existing.health = null;
      existing.healthProbe = null;
      this.scheduleProbe(existing);
      return;
    }
    const entry: Entry = {
      provider,
      tier,
      stats: freshStats(provider.name, tier, provider.isAvailable()),
      probeInFlight: false,
      probeAt: null,
      health: null,
      healthProbe: null,
    };
    this.entries.set(provider.name, entry);
    this.logger.debug('provider registered', { provider: provider.name, tier });
    this.scheduleProbe(entry);
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
   * Providers eligible right now: has a key, its health probe has not failed,
   * and its circuit is not `open`. An `open` circuit whose cooldown has
   * elapsed is transitioned to `half_open` here, which makes exactly one
   * probe eligible.
   */
  public getAvailable(tier?: ProviderTier): AiProvider[] {
    const now = this.now();
    const tierMatches: AiProvider[] = [];
    const all: AiProvider[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.provider.isAvailable()) {
        entry.stats.available = false;
        continue;
      }
      entry.stats.available = true;
      // A provider whose health probe failed is skipped: selecting it would
      // only burn the attempt budget of every request on a dead key or a
      // wrong base URL.
      if (this.isUnhealthy(entry, now)) continue;
      this.refreshCircuit(entry, now);
      if (entry.stats.circuit.state === 'open') continue;
      // A half-open circuit allows exactly ONE probe, not one per request.
      if (entry.stats.circuit.state === 'half_open' && this.probeOutstanding(entry, now)) continue;
      all.push(entry.provider);
      if (tier === undefined || entry.tier === tier) tierMatches.push(entry.provider);
    }
    if (tierMatches.length > 0) return tierMatches;
    // The requested tier is empty (for example only a "planning" tier provider
    // is configured). A configured provider of another tier is still usable,
    // so cross tiers instead of failing the request outright.
    if (tier !== undefined && all.length > 0) {
      this.logger.info('no provider in the requested tier, falling back across tiers', {
        tier,
        candidates: all.length,
      });
      // Mark the half-open probes we are actually handing out.
      for (const entry of this.entries.values()) {
        if (entry.stats.circuit.state === 'half_open' && all.includes(entry.provider)) {
          this.markProbe(entry, now);
        }
      }
      return all;
    }
    // Mark the half-open probes we are actually handing out.
    for (const entry of this.entries.values()) {
      if (entry.stats.circuit.state === 'half_open' && all.includes(entry.provider)) {
        this.markProbe(entry, now);
      }
    }
    return all;
  }

  /** Current circuit state, applying any pending cooldown transition. */
  public circuitState(name: ProviderName): CircuitState | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    this.refreshCircuit(entry, this.now());
    return entry.stats.circuit.state;
  }

  // --- health probe --------------------------------------------------------------

  /**
   * The cached health verdict for a provider, or undefined when it has never
   * been probed.
   */
  public healthOf(name: ProviderName): { ok: boolean; checkedAt: number } | undefined {
    const health = this.entries.get(name)?.health;
    return health ?? undefined;
  }

  /**
   * Probes one provider now and caches the verdict.
   *
   * The request path never awaits a probe - a provider whose key was revoked
   * must not add latency to every request. This method exists for callers
   * that want the answer before deciding anything.
   */
  public async probeHealth(name: ProviderName): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry) return false;
    if (entry.healthProbe !== null) return entry.healthProbe;
    const probe = this.runProbe(entry);
    entry.healthProbe = probe;
    try {
      return await probe;
    } finally {
      if (entry.healthProbe === probe) entry.healthProbe = null;
    }
  }

  /**
   * True when the last health probe said "no".
   *
   * The verdict stays authoritative for `healthTtlMs`; once it is stale a
   * fresh probe is scheduled in the background, but the provider stays out of
   * the rotation until that probe says it is healthy again. A provider that
   * has never been probed is allowed through - the verdict may simply not be
   * in yet.
   */
  private isUnhealthy(entry: Entry, now: number): boolean {
    const health = entry.health;
    if (health === null || health.ok) return false;
    if (now - health.checkedAt >= this.healthTtlMs) {
      // The verdict is stale: refresh it in the background so a recovered
      // provider can come back without a restart.
      this.scheduleProbe(entry);
    }
    return true;
  }

  /** Starts a background health probe, unless one is already running. */
  private scheduleProbe(entry: Entry): void {
    if (entry.healthProbe !== null) return;
    const probe = this.runProbe(entry);
    entry.healthProbe = probe;
    void probe
      .catch(() => false)
      .finally(() => {
        if (entry.healthProbe === probe) entry.healthProbe = null;
      });
  }

  /**
   * Runs one health probe and caches the verdict.
   * Never rejects: a probe that throws simply means "unhealthy".
   */
  private async runProbe(entry: Entry): Promise<boolean> {
    const provider = entry.provider;
    const name = provider.name;
    let ok = false;
    try {
      ok = await provider.healthCheck();
    } catch (error) {
      ok = false;
      this.logger.warn('provider health probe threw', {
        provider: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // A provider that was replaced while the probe was running says nothing
    // about the new one: the stale verdict is dropped.
    if (entry.provider === provider) {
      entry.health = { ok, checkedAt: this.now() };
      if (!ok) {
        this.logger.warn('provider health probe failed, skipping it until it recovers', { provider: name });
      }
    }
    return ok;
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
    // The half-open probe concluded: its slot is free again.
    this.releaseProbe(entry);
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
    // The half-open probe concluded (with a failure): its slot is free again.
    this.releaseProbe(entry);
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
    // The call is deferred into a microtask so a provider that throws
    // *synchronously* becomes a rejected result instead of aborting the whole
    // disposal (the other providers would never be released).
    const results = await Promise.allSettled(
      providers.map((provider) => Promise.resolve().then(() => provider.dispose())),
    );
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
      // A fresh half-open window: the single probe slot is free again. A
      // reservation left over from the previous window must not keep the
      // provider out of the rotation forever.
      this.releaseProbe(entry);
      this.logger.info('circuit half-open, probing', { provider: entry.provider.name });
    }
  }

  /**
   * True while the single half-open probe slot of a provider is taken.
   *
   * The slot is released when the probe concludes (success or failure) and
   * when the circuit is re-armed. A probe whose outcome was never recorded -
   * the caller aborted the request - must not strand the provider, so the
   * reservation also expires after one cooldown.
   */
  private probeOutstanding(entry: Entry, now: number): boolean {
    if (!entry.probeInFlight) return false;
    if (entry.probeAt !== null && now - entry.probeAt >= this.cooldownMs) return false;
    return true;
  }

  /** Reserves the single half-open probe slot of a provider. */
  private markProbe(entry: Entry, now: number): void {
    entry.probeInFlight = true;
    entry.probeAt = now;
  }

  /** Frees the half-open probe slot of a provider. */
  private releaseProbe(entry: Entry): void {
    entry.probeInFlight = false;
    entry.probeAt = null;
  }

  private ema(previous: number, sample: number): number {
    return this.emaAlpha * sample + (1 - this.emaAlpha) * previous;
  }
}