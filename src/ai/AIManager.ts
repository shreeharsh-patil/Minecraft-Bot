/**
 * The public face of the AI subsystem.
 *
 * Everything above this file talks to `plan()` and nothing else; provider
 * selection, fallback, circuit breaking, prompt construction and action
 * validation all live behind this facade.
 *
 * Responsibilities:
 *  - build adapters from config and register them with the router;
 *  - bound concurrency (`ai.maxConcurrentRequests`) with a FIFO queue;
 *  - enforce the overall deadline so a dead AI API can never hang the bot;
 *  - support `cancelAll()` for the `!stop` command;
 *  - expose provider stats for status reporting.
 */
import type { AiConfig } from '../config/config.js';
import type { AiProvider, ProviderStats, ProviderTier } from '../types/provider.js';
import type { BotAction } from '../types/actions.js';
import { AIUnavailableError, AIRouter } from './router.js';
import { Planner } from './planner.js';
import type { PlanRequest, PlanResult } from './planner.js';
import { GeminiProvider } from './providers/GeminiProvider.js';
import { GroqProvider } from './providers/GroqProvider.js';
import { OpenAIProvider } from './providers/OpenAIProvider.js';
import { OpenRouterProvider } from './providers/OpenRouterProvider.js';
import { LocalPlanner } from './localPlanner.js';
import { createDeferred } from '../utils/sleep.js';
import { silentLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

/** Anything that can turn a `PlanRequest` into a `PlanResult`. */
export interface PlannerLike {
  plan(request: PlanRequest): Promise<PlanResult>;
}

export interface AIManagerOptions {
  config: AiConfig;
  logger?: Logger;
  /** Pre-built adapters. When omitted they are constructed from `config`. */
  providers?: AiProvider[];
  temperature?: number;
  maxTokens?: number;
  maxActions?: number;
}

export interface AIManagerStats {
  /** Number of requests currently executing. */
  inFlight: number;
  /** Number of requests waiting for a concurrency slot. */
  queued: number;
  /** Total plans completed since start. */
  planned: number;
  /** Total requests rejected before reaching a provider. */
  rejected: number;
  providers: ProviderStats[];
  /** 'local' = algorithmic planner with zero API keys. */
  plannerMode: 'llm' | 'local';
}

interface QueueEntry {
  resolve: () => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Maps a configured provider name to its adapter. */
function createProvider(
  entry: AiConfig['providers'][number],
  logger: Logger,
): AiProvider {
  switch (entry.name) {
    case 'openai':
      return new OpenAIProvider({ apiKey: entry.apiKey, model: entry.model, logger });
    case 'groq':
      return new GroqProvider({ apiKey: entry.apiKey, model: entry.model, logger });
    case 'openrouter':
      return new OpenRouterProvider({ apiKey: entry.apiKey, model: entry.model, logger });
    case 'gemini':
      return new GeminiProvider({ apiKey: entry.apiKey, model: entry.model, logger });
  }
}

/** Tier hint per provider: Gemini/OpenAI are planning-capable, Groq is fast. */
function tierFor(name: AiProvider['name']): ProviderTier {
  return name === 'gemini' || name === 'openai' ? 'planning' : 'fast';
}

export class AIManager {
  public readonly router: AIRouter;
  /** The LLM planner or, with no keys configured, the algorithmic one. */
  public readonly planner: PlannerLike;
  /** How requests are planned: 'llm' with providers, 'local' without keys. */
  public readonly plannerMode: 'llm' | 'local';

  private readonly logger: Logger;
  private readonly maxConcurrent: number;
  private readonly requestTimeoutMs: number;

  private queue: QueueEntry[] = [];
  private inFlight = 0;
  private planned = 0;
  private rejected = 0;
  private disposed = false;

  /**
   * Aborted by `cancelAll()` (the `!stop` path) and by `dispose()`.
   *
   * It is REPLACED, not permanently aborted: `!stop` must cancel the work in
   * flight without bricking the manager for every later request. A one-shot
   * controller here meant the first `!stop` (which the bot itself issues
   * before every new request) made every later plan throw "AI manager is
   * shutting down" - the AI path was dead in production.
   */
  private cancellation = new AbortController();

  constructor(options: AIManagerOptions) {
    const { config } = options;
    this.logger = options.logger ?? silentLogger;
    // `Math.max(1, NaN)` is NaN and `Math.max(1, Infinity)` is Infinity: a
    // non-finite config would either queue every request forever (NaN makes
    // `inFlight < maxConcurrent` false for every value) or silently drop the
    // concurrency limit altogether (Infinity). Fall back to a safe value.
    this.maxConcurrent = Number.isFinite(config.maxConcurrentRequests)
      ? Math.max(1, Math.floor(config.maxConcurrentRequests))
      : 1;
    this.requestTimeoutMs = Number.isFinite(config.requestTimeoutMs)
      ? Math.max(500, Math.floor(config.requestTimeoutMs))
      : 500;

    this.router = new AIRouter({
      // A non-finite deadline must never reach a timer: `setTimeout(fn, NaN)`
      // fires after 1ms and poisons every deadline comparison downstream.
      requestTimeoutMs: Number.isFinite(config.requestTimeoutMs)
        ? config.requestTimeoutMs
        : this.requestTimeoutMs,
      failureThreshold: config.circuitFailureThreshold,
      cooldownMs: config.circuitCooldownMs,
      ...(config.planningModel !== undefined ? { planningModel: config.planningModel } : {}),
      logger: this.logger,
    });

    const providers =
      options.providers ??
      config.providers.map((entry) => createProvider(entry, this.logger.child({ provider: entry.name })));

    for (const provider of providers) {
      this.router.pool.register(provider, tierFor(provider.name));
    }
    if (providers.length === 0 && config.localPlanner) {
      this.plannerMode = 'local';
      this.logger.warn(
        'no AI provider API keys configured - the built-in algorithmic planner is handling requests offline',
      );
    } else {
      this.plannerMode = 'llm';
      if (providers.length === 0) {
        this.logger.warn('no AI providers configured; planning will always fail');
      }
    }

    if (this.plannerMode === 'local') {
      this.planner = new LocalPlanner({
        logger: this.logger,
        ...(options.maxActions !== undefined ? { maxActions: options.maxActions } : {}),
      });
    } else {
      this.planner = new Planner({
        router: this.router,
        logger: this.logger,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.maxActions !== undefined ? { maxActions: options.maxActions } : {}),
      });
    }
  }

  /**
   * The single entry point used by the rest of the bot.
   *
   * Returns an empty array when the model declined or when every provider
   * failed - the bot must keep running either way. Throws only for genuine
   * misuse (disposed manager) so callers can distinguish "no plan" from "bug".
   */
  public async plan(request: PlanRequest): Promise<BotAction[]> {
    const result = await this.planDetailed(request);
    return result.actions;
  }

/** Same as `plan` but exposes provider/latency/dropped-action detail. */
  public async planDetailed(request: PlanRequest): Promise<PlanResult> {
    if (this.disposed) throw new Error('AIManager has been disposed');

    // Link the caller's signal with the manager-wide one (`!stop`) BEFORE the
    // first await. `cancelAll()` REPLACES the manager-wide controller, so a
    // request that linked afterwards would attach to the fresh, unaborted
    // generation and run to completion even though `!stop` had already
    // counted it as cancelled.
    const linked = this.linkSignals(request.signal);
    try {
      const release = await this.acquire(request.signal);
      try {
        const started = Date.now();
        const result = await this.planOrDegrade(request, linked.signal);
        this.planned += 1;
        this.logger.debug('plan complete', {
          requester: request.requester,
          actions: result.actions.length,
          provider: result.provider,
          latencyMs: result.latencyMs,
          totalMs: Date.now() - started,
        });
        return result;
      } finally {
        release();
      }
    } finally {
      linked.dispose();
    }
  }

  /**
   * Runs the planner, degrading a provider outage into an empty plan.
   *
   * The contract of this class is "an empty array when the model declined or
   * when every provider failed - the bot must keep running either way". The
   * router signals a total outage with `AIUnavailableError`; without this
   * catch the bot would reject the request and the outage would be
   * invisible in the stats.
   *
   * The failure stays visible: it is logged, it lands in the dropped-action
   * list, and the provider stats still show the failures.
   */
  private async planOrDegrade(request: PlanRequest, signal: AbortSignal): Promise<PlanResult> {
    try {
      return await this.planner.plan({ ...request, signal });
    } catch (error) {
      if (!(error instanceof AIUnavailableError)) throw error;
      this.logger.warn('no AI provider could answer; continuing with an empty plan', {
        requester: request.requester,
        failures: error.failures.map((failure) => `${failure.provider}:${failure.kind}`),
      });
      return {
        actions: [],
        dropped: [{ reason: 'ai-unavailable', raw: error.message }],
        provider: null,
        latencyMs: 0,
        rawText: '',
      };
    }
  }

  /**
   * Aborts every in-flight plan and rejects queued ones. This is what `!stop`
   * calls: the HTTP requests are really cancelled, not merely ignored.
   *
   * Returns how many requests were cancelled (useful for logs).
   */
  public cancelAll(reason = 'cancelled'): number {
    // Abort the current generation and install a fresh one: cancelling the
    // work in flight must not disable planning for the next request.
    const current = this.cancellation;
    this.cancellation = new AbortController();
    current.abort(new Error(reason));

    const queued = this.queue;
    this.queue = [];
    const cancelled = queued.length + this.inFlight;
    for (const entry of queued) {
      clearTimeout(entry.timer);
      // A queued request never reached a provider: count it as rejected, the
      // same way the queue timeout and the abort-while-queued paths do.
      this.rejected += 1;
      entry.reject(new Error(reason));
    }
    this.logger.info('in-flight AI requests cancelled', { reason, inFlight: this.inFlight, cancelled });
    return cancelled;
  }

  public stats(): AIManagerStats {
    return {
      inFlight: this.inFlight,
      queued: this.queue.length,
      planned: this.planned,
      rejected: this.rejected,
      providers: this.router.pool.stats(),
      plannerMode: this.plannerMode,
    };
  }

  /** Human-readable brain description for `!status`. */
  public brainLabel(): string {
    return this.plannerMode === 'local'
      ? 'Brain: algorithmic planner (offline, no API keys).'
      : `Brain: ${this.router.pool.stats().length} AI provider(s).`;
  }

  /** Releases provider sockets and cancels outstanding work. */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll('disposing');
    // `cancelAll` installs a fresh controller; dispose must kill that too.
    this.cancellation.abort(new Error('disposing'));
    await this.router.pool.disposeAll();
  }

// --- concurrency --------------------------------------------------------------

  /**
   * Reserves one of the `maxConcurrentRequests` slots, queueing if necessary.
   * The returned function releases the slot and wakes the next waiter.
   *
   * A queued request is dropped rather than left hanging if it is aborted while
   * waiting, so `!stop` always takes effect immediately.
   */
  private async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('Request aborted before it started');
    if (this.disposed) throw new Error('AI manager has been disposed');

    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return this.makeRelease();
    }

    this.logger.debug('AI request queued', { inFlight: this.inFlight, queued: this.queue.length });
    const deferred = createDeferred<void>();
    // Never wait forever in the queue: a slot frees up or the deadline expires.
    const timer = setTimeout(() => {
      this.removeFromQueue(entry);
      this.rejected += 1;
      deferred.reject(new Error(`Timed out waiting for an AI slot after ${this.requestTimeoutMs}ms`));
    }, this.requestTimeoutMs);
    timer.unref();

    const entry: QueueEntry = {
      resolve: () => deferred.resolve(),
      reject: (reason: unknown) => deferred.reject(reason),
      timer,
    };

    const onAbort = (): void => {
      if (this.removeFromQueue(entry)) {
        clearTimeout(timer);
        this.rejected += 1;
        deferred.reject(new Error('Request aborted while queued'));
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    this.queue.push(entry);
    try {
      await deferred.promise;
    } catch (error) {
      // The slot was never taken: only the success path may count as in-flight,
      // otherwise a cancelled/expired queue wait shrinks capacity forever.
      signal?.removeEventListener('abort', onAbort);
      throw error;
    }
    signal?.removeEventListener('abort', onAbort);
    this.inFlight += 1;
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      }
    };
  }

  private removeFromQueue(entry: QueueEntry): boolean {
    const index = this.queue.indexOf(entry);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    return true;
  }

  /**
   * Combines the caller's signal with the manager-wide one so that either a
   * per-task abort or a global `!stop` cancels the underlying HTTP request.
   */
  private linkSignals(caller?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const sources = [caller, this.cancellation.signal].filter((s): s is AbortSignal => s !== undefined);
    const cleanups: Array<() => void> = [];

    for (const source of sources) {
      if (source.aborted) {
        controller.abort(source.reason);
        break;
      }
      const onAbort = (): void => controller.abort(source.reason);
      source.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => source.removeEventListener('abort', onAbort));
    }

    return {
      signal: controller.signal,
      dispose: () => {
        for (const cleanup of cleanups) cleanup();
      },
    };
  }
}