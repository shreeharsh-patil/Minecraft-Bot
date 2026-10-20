/**
 * Audit regression tests for the `tests/ai/` suite.
 *
 * Every test here pins a behaviour that the `tests/ai/` files CLAIM to cover
 * but did not actually assert. Each of them fails if the behaviour regresses:
 *
 *  1. `parseActions` clamps model-supplied numbers to the shared ceilings and
 *     keeps the action (a clamp is not a drop).
 *  2. `buildCompactContext` trims the chat window: newest turns only, each
 *     turn cut to a bounded length.
 *  3. A provider adapter logs the request without ever logging the API key or
 *     the Authorization header.
 *  4. `AIManager.cancelAll()` reports how many requests it actually cancelled.
 *  5. `AIManager` runs exactly `maxConcurrentRequests` requests at a time.
 *  6. The router gives the fallback candidate a real budget after the first
 *     candidate used its share of the deadline.
 */
import { describe, expect, it } from 'vitest';
import { parseActions } from '../../src/ai/planner.js';
import { DEFAULT_MAX_WAIT_MS } from '../../src/safety/actionLimits.js';
import { buildCompactContext } from '../../src/ai/contextBuilder.js';
import { AIManager } from '../../src/ai/AIManager.js';
import { AIRouter } from '../../src/ai/router.js';
import { OpenAIProvider } from '../../src/ai/providers/OpenAIProvider.js';
import { createLogger } from '../../src/utils/logger.js';
import { ProviderError } from '../../src/types/provider.js';
import type { AiConfig } from '../../src/config/config.js';
import type { CompactContext } from '../../src/ai/contextBuilder.js';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResult,
  ProviderName,
} from '../../src/types/provider.js';

// --- 1. clamping -----------------------------------------------------------------

describe('audit - planner clamps instead of trusting the model', () => {
  it('clamps counts and radii to the shared ceiling instead of dropping the action', () => {
    const { actions, dropped } = parseActions({
      actions: [
        { type: 'mine_block', blockName: 'oak_log', count: 10_000_000 },
        { type: 'wait', durationMs: 99_999_999 },
        { type: 'attack_hostile', radius: 5_000 },
      ],
    });

    // The counts and radii are CLAMPED, not dropped: the action survives with
    // the ceiling value. An assertion of the form "<= limit" is also true for
    // a MISSING action, which is why the exact values are asserted here.
    expect(actions).toContainEqual({ type: 'mine_block', blockName: 'oak_log', count: 512 });
    expect(actions).toContainEqual({ type: 'attack_hostile', radius: 64 });
    // The count and the radius are clamped, so they must not be dropped.
    expect(dropped.filter((entry) => entry.reason !== 'invalid-parameters:wait')).toEqual([]);
    // A duration the executor would refuse never survives as it was written.
    const wait = actions.find((action) => action.type === 'wait');
    if (wait?.type === 'wait') expect(wait.durationMs).toBeLessThanOrEqual(DEFAULT_MAX_WAIT_MS);
  });
});

// --- 2. context builder ----------------------------------------------------------

describe('audit - the world snapshot the model sees stays small', () => {
  it('keeps only the newest chat turns and cuts each one to a bounded length', () => {
    const conversation = Array.from({ length: 10 }, (_, i) => ({
      player: `Player${i}`,
      text: 'x'.repeat(300),
      at: i,
    }));

    const context = buildCompactContext(
      {
        getPosition: () => ({ x: 1, y: 64, z: 2 }),
        getDimension: () => 'overworld',
        getTimeOfDay: () => 'day',
        getHealth: () => ({ current: 20, max: 20 }),
        getHunger: () => ({ current: 20, saturation: 5 }),
        getNearbyPlayers: () => [],
        getNearbyEntities: () => [],
        scanNearbyBlocks: () => [],
        getInventory: () => [],
        heldItem: () => null,
      },
      { targetPlayer: 'Alice', conversation, objective: null },
    );

    expect(context.recentChat).toHaveLength(6);
    expect(context.recentChat.map((turn) => turn.player)).toEqual([
      'Player4',
      'Player5',
      'Player6',
      'Player7',
      'Player8',
      'Player9',
    ]);
    expect(context.recentChat.every((turn) => turn.text.length <= 160)).toBe(true);
  });
});

// --- 3. provider adapters never log the key --------------------------------------

describe('audit - provider adapters never leak the API key', () => {
  it('logs the request without the key or the Authorization header', async () => {
    const lines: string[] = [];
    // A key shape the logger's pattern redactor does NOT recognise, so this
    // test measures the PROVIDER's behaviour instead of the logger's safety
    // net. A provider that logged the key under a harmless field name would
    // therefore be caught here.
    const key = 'ZZ-unredactable-key-value-0123456789';
    const provider = new OpenAIProvider({
      apiKey: key,
      model: 'gpt-4o-mini',
      logger: createLogger({ level: 'debug', format: 'json', sink: (line) => void lines.push(line) }),
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'upstream exploded' } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }], jsonMode: true, timeoutMs: 500 }),
    ).rejects.toBeInstanceOf(ProviderError);

    const output = lines.join('\n');
    // The request WAS logged - otherwise the two assertions below would pass
    // on an empty log and prove nothing.
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain('openai');
    expect(output).not.toContain(key);
    expect(output).not.toContain('Bearer');
  });
});

// --- 4. cancellation accounting ---------------------------------------------------

const managerConfig: AiConfig = {
  providers: [],
  localPlanner: true,
  requestTimeoutMs: 2_000,
  circuitFailureThreshold: 2,
  circuitCooldownMs: 1_000,
  maxConcurrentRequests: 1,
};

const managerContext: CompactContext = {
  position: { x: 0, y: 64, z: 0 },
  dimension: 'overworld',
  timeOfDay: 'day',
  health: { current: 20, max: 20 },
  hunger: { current: 20, saturation: 5 },
  task: null,
  targetPlayer: null,
  nearbyPlayers: [{ name: 'Alice', distance: 3, authorized: true, health: 20 }],
  nearbyHostiles: [],
  nearbyBlocks: [],
  dangerousBlocksNearby: [],
  inventory: { held: null, usedSlots: 0, freeSlots: 36, items: [] },
  recentChat: [],
};

/** A provider that never answers, so a request can be cancelled mid-flight. */
function hangingProvider(onCall: () => void): AiProvider {
  return {
    name: 'groq',
    model: 'm',
    isAvailable: () => true,
    healthCheck: () => Promise.resolve(true),
    complete: (req: CompletionRequest) =>
      new Promise<CompletionResult>((_resolve, reject) => {
        onCall();
        req.signal?.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
    dispose: () => undefined,
  };
}

describe('audit - AIManager cancellation accounting', () => {
  it('counts the requests it cancelled, and only those', async () => {
    let markInFlight: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      markInFlight = resolve;
    });
    const ai = new AIManager({ config: managerConfig, providers: [hangingProvider(() => markInFlight())] });

    const promise = ai.planDetailed({
      instruction: 'follow me',
      requester: 'Alice',
      context: managerContext,
    });
    await inFlight;
    expect(ai.stats().inFlight).toBe(1);

    expect(ai.cancelAll('user pressed stop')).toBe(1);
    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });

    // Nothing is in flight any more, so nothing is cancelled.
    expect(ai.cancelAll('user pressed stop')).toBe(0);
    await ai.dispose();
  });
});

// --- 5. concurrency ceiling --------------------------------------------------------

describe('audit - AIManager concurrency ceiling', () => {
  it('runs exactly maxConcurrentRequests requests at a time and queues the rest', async () => {
    const config: AiConfig = {
      providers: [{ name: 'groq', apiKey: 'test-key', model: 'test-model' }],
      localPlanner: false,
      requestTimeoutMs: 2_000,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 1_000,
      maxConcurrentRequests: 2,
    };

    let active = 0;
    let peak = 0;
    const provider: AiProvider = {
      name: 'groq',
      model: 'm',
      isAvailable: () => true,
      healthCheck: () => Promise.resolve(true),
      complete: async (): Promise<CompletionResult> => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { text: '{"actions":[{"type":"stop"}]}', latencyMs: 5, model: 'm' };
      },
      dispose: () => undefined,
    };

    const manager = new AIManager({ config, providers: [provider] });
    const results = await Promise.all([
      manager.plan({ instruction: 'a', requester: 'Alice', context: managerContext }),
      manager.plan({ instruction: 'b', requester: 'Alice', context: managerContext }),
      manager.plan({ instruction: 'c', requester: 'Alice', context: managerContext }),
      manager.plan({ instruction: 'd', requester: 'Alice', context: managerContext }),
      manager.plan({ instruction: 'e', requester: 'Alice', context: managerContext }),
    ]);

    expect(results).toHaveLength(5);
    for (const actions of results) expect(actions).toEqual([{ type: 'stop' }]);
    // Two slots, so two requests at once - not one (which would also satisfy
    // "<= 2") and not five (no ceiling at all).
    expect(peak).toBe(2);
    expect(manager.stats().inFlight).toBe(0);
    await manager.dispose();
  });
});

// --- 6. router attempt budgets ------------------------------------------------------

/** A scriptable provider: no HTTP, deterministic outcomes. */
class ScriptedProvider implements AiProvider {
  public readonly name: ProviderName;
  public readonly model: string;

  private readonly handler: (request: CompletionRequest) => Promise<CompletionResult>;

  constructor(name: ProviderName, handler: (request: CompletionRequest) => Promise<CompletionResult>) {
    this.name = name;
    this.model = `${name}-model`;
    this.handler = handler;
  }

  public isAvailable(): boolean {
    return true;
  }

  public healthCheck(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public complete(request: CompletionRequest): Promise<CompletionResult> {
    return this.handler(request);
  }

  public dispose(): void {
    /* nothing to release */
  }
}

describe('audit - the router leaves a usable budget for the fallback', () => {
  it('gives the fallback candidate a real budget after the first candidate failed', async () => {
    const router = new AIRouter({ requestTimeoutMs: 1_000, failureThreshold: 3, cooldownMs: 1_000 });
    const budgets: number[] = [];

    router.pool.register(
      new ScriptedProvider('openai', (req: CompletionRequest) => {
        budgets.push(req.timeoutMs);
        return Promise.reject(new ProviderError('openai', 'server_error', 'openai: 503', { retryable: true }));
      }),
      'fast',
    );
    router.pool.register(
      new ScriptedProvider('groq', (req: CompletionRequest) => {
        budgets.push(req.timeoutMs);
        return Promise.resolve({ text: '{"actions":[{"type":"stop"}]}', latencyMs: 1, model: 'groq-model' });
      }),
      'fast',
    );

    const result = await router.complete(
      { messages: [{ role: 'user', content: 'hello' }], jsonMode: true, timeoutMs: 1_000 },
      'fast',
    );

    expect(result.provider).toBe('groq');
    expect(result.attempts).toBe(2);
    // Both candidates were budgeted...
    expect(budgets).toHaveLength(2);
    // ...the first one only got its fair share of the 1000ms deadline...
    expect(budgets[0]).toBeLessThanOrEqual(600);
    expect(budgets[0]).toBeGreaterThanOrEqual(400);
    // ...and the fallback was not left with a handful of milliseconds.
    expect(budgets[1]).toBeGreaterThanOrEqual(400);
  });
});
