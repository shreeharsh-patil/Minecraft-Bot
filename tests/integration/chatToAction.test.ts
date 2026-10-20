/**
 * End-to-end test of the whole request path:
 *
 *   mineflayer chat event -> wireBotEvents -> ChatListener -> authorization
 *   -> planner -> executor -> skill -> facade
 *
 * Every layer above was unit tested, but the wiring between them was not: the
 * bot shipped with a chat listener that never received a single message, and
 * an AI manager that was bricked by the first request. This test exercises the
 * real components together, so a break in the chain shows up here.
 *
 * Two details of the production wiring are easy to leave out of a test, and
 * both of them were real bugs:
 *
 *  - the chat line must arrive through the REAL event wiring
 *    (`wireBotEvents`), not be handed to the listener directly. The "the
 *    listener never received a single message" bug lived in exactly that hop,
 *    so a test that skips it cannot catch it.
 *  - the request handler cancels the work in flight BEFORE it plans, because
 *    every new request (and `!stop`) does the same in `BotApp`. A manager that
 *    is permanently aborted by that cancel can never plan again, which is the
 *    "the AI manager was bricked by the first request" bug.
 */
import { describe, expect, it } from 'vitest';
import { ChatListener } from '../../src/chat/chatListener.js';
import { ChatResponder } from '../../src/chat/responses.js';
import { LocalCommands } from '../../src/commands/index.js';
import { createSkillRegistry } from '../../src/skills/index.js';
import { ActionExecutor } from '../../src/executor/actionExecutor.js';
import { ActionLimits } from '../../src/safety/actionLimits.js';
import { AntiGriefRules } from '../../src/safety/antiGrief.js';
import { AuthorizationService } from '../../src/safety/permissions.js';
import { TaskManager } from '../../src/executor/actionQueue.js';
import { AIManager } from '../../src/ai/AIManager.js';
import { buildCompactContext, type WorldContextSource } from '../../src/ai/contextBuilder.js';
import { createMemoryStore } from '../../src/ai/memory.js';
import { wireBotEvents } from '../../src/bot/events.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { silentLogger } from '../../src/utils/logger.js';
import type { AiConfig } from '../../src/config/config.js';
import type { AppConfig } from '../../src/config/config.js';
import type { BotAction } from '../../src/types/actions.js';

const aiConfig: AiConfig = {
  providers: [],
  localPlanner: true,
  requestTimeoutMs: 2_000,
  circuitFailureThreshold: 2,
  circuitCooldownMs: 1_000,
  maxConcurrentRequests: 2,
};

const appConfig = {
  minecraft: {
    host: 'localhost',
    port: 25565,
    username: 'TestBot',
    auth: 'offline',
  },
  ai: aiConfig,
  authorizedPlayers: new Set(['alice']),
  chat: { prefix: '!', rateLimit: { windowMs: 10_000, maxCommands: 8 } },
  presence: { enabled: false, timeoutSeconds: 60 },
  safety: {
    maxActionsPerMinute: 30,
    maxMiningBlocksPerTask: 512,
    maxBuildBlocksPerTask: 512,
    followDistance: 3,
  },
  runtime: {
    logLevel: 'silent',
    logFormat: 'pretty',
    maxReconnectAttempts: 3,
    reconnectBaseDelayMs: 1_000,
  },
  warnings: [],
} as unknown as AppConfig;

/** The UUIDs the server sends as the chat sender on 1.19+ (the 1.21.1 shape). */
const UUIDS = {
  Alice: '10920508-d5d8-3eed-93d2-92f193afe7d7',
  Mallory: '3b7b0f5e-1f0a-4f31-9a0c-6a5f1b7c8d21',
} as const;

type SenderName = keyof typeof UUIDS;

interface FakeBot {
  bot: never;
  emit: (event: string, ...args: unknown[]) => void;
}

/** The bits of the mineflayer bot the event wiring touches. */
function fakeBot(): FakeBot {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const bot = {
    on: (event: string, handler: (...args: unknown[]) => void): void => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    removeListener: (event: string, handler: (...args: unknown[]) => void): void => {
      const list = handlers.get(event) ?? [];
      handlers.set(event, list.filter((entry) => entry !== handler));
    },
    health: 20,
    // The player list the server sends: UUID -> username.
    uuidToUsername: { [UUIDS.Alice]: 'Alice', [UUIDS.Mallory]: 'Mallory' },
  };
  return {
    bot: bot as never,
    emit: (event: string, ...args: unknown[]): void => {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
}

interface Harness {
  facade: FakeMinecraftFacade;
  ai: AIManager;
  /** Delivers a chat line through the real mineflayer event hop. */
  chat: (text: string, sender?: SenderName) => Promise<void>;
}

/**
 * The world view the AI layer gets.
 *
 * `WorldContextSource` asks for the dimension through a method, which the
 * facade only offers optionally, so the view is spelled out here rather than
 * handed over as the facade itself.
 */
function worldSource(facade: FakeMinecraftFacade): WorldContextSource {
  return {
    getPosition: () => facade.getPosition(),
    getDimension: () => facade.dimension,
    getTimeOfDay: () => facade.getTimeOfDay(),
    getHealth: () => facade.getHealth(),
    getHunger: () => facade.getHunger(),
    getNearbyPlayers: (maxDistance) => facade.getNearbyPlayers(maxDistance),
    getNearbyEntities: (maxDistance) => facade.getNearbyEntities(maxDistance),
    scanNearbyBlocks: (radius) => facade.scanNearbyBlocks(radius),
    getInventory: () => facade.getInventory(),
    heldItem: () => facade.heldItem(),
  };
}

function harness(): Harness {
  const facade = new FakeMinecraftFacade({
    players: [
      {
        name: 'Alice',
        distance: 6,
        position: { x: 6, y: 64, z: 0 },
        authorized: true,
      },
    ],
  });
  const logger = silentLogger;
  const tasks = new TaskManager(logger);
  const responder = new ChatResponder(logger, 0);
  // The responder only logs by default; the bot injects the real sink.
  responder.emit = (text: string): void => {
    facade.chat(text);
  };
  const auth = new AuthorizationService(appConfig);
  const memory = createMemoryStore({ logger });
  const limits = new ActionLimits(appConfig.safety);
  const antiGrief = new AntiGriefRules();
  const registry = createSkillRegistry(facade);
  const executor = new ActionExecutor({
    facade,
    tasks,
    registry,
    limits,
    antiGrief,
    logger,
    say: (target, message) => {
      void target;
      void message;
    },
  });
  const ai = new AIManager({ config: aiConfig, logger });

  // Mirrors `BotApp.stopEverything`: a new request cancels everything that is
  // in flight before the next plan is made.
  const stopEverything = (reason: string): void => {
    tasks.cancelAll(reason);
    executor.cancelActivePlan(reason);
    ai.cancelAll(reason);
    facade.stopMoving();
  };

  const local = new LocalCommands({
    facade,
    tasks,
    auth,
    memory,
    responder,
    prefix: '!',
    providerStats: () => 'Brain: algorithmic planner (offline).',
    logger,
    runAction: async (owner, action) => {
      await executor.runSingle(owner, action);
    },
  });

  const listener = new ChatListener({
    facade,
    responder,
    auth,
    memory,
    prefix: '!',
    logger,
    runDeterministic: async (owner, action) => {
      // `!come` targets the requesting player: the parser leaves the name
      // empty and the caller fills it in.
      const resolved: BotAction =
        action.type === 'move_to_player' && action.player === ''
          ? { ...action, player: owner }
          : action;
      await executor.runSingle(owner, resolved);
    },
    handleNaturalLanguage: async (owner, text) => {
      // Mirror the real app: cancel what is in flight, acknowledge, then act.
      stopEverything('new request');
      await responder.send(owner, 'Got it, working on it.');
      const plan = await ai.planDetailed({
        instruction: text,
        requester: owner,
        context: buildCompactContext(worldSource(facade), memory.shortTerm, { logger }),
      });
      if (plan.actions.length > 0) {
        await executor.runPlan(owner, plan.actions);
      }
    },
    stopEverything: (reason) => {
      stopEverything(reason);
    },
    handleLocal: async (owner, name, args) => {
      await local.handle(owner, name, args);
    },
  });

  const { bot, emit } = fakeBot();
  // Every chat line the event wiring hands over, so the test can wait for the
  // listener to finish with it.
  const inFlight: Array<Promise<void>> = [];
  wireBotEvents({
    bot,
    logger,
    onChat: (username, message) => {
      inFlight.push(listener.handle({ username, message }));
    },
    onDisconnect: () => undefined,
  });

  return {
    facade,
    ai,
    chat: async (text: string, sender: SenderName = 'Alice'): Promise<void> => {
      inFlight.length = 0;
      const uuid = UUIDS[sender];
      // The real 1.19+ payload: the rendered line carries "<Name> " and the
      // sender argument is a UUID, not a name.
      emit('message', { toString: () => `<${sender}> ${text}` }, 'chat', uuid, true);
      await Promise.all(inFlight);
    },
  };
}

describe('end-to-end: a chat message reaches the world', () => {
  it('runs the requested action and answers the player', async () => {
    const h = harness();

    // A plain chat line from the authorized player must produce an action.
    // "come here" is a one-shot movement: a persistent task (follow) would
    // keep the plan running for its full duration.
    await h.chat('come here');

    // The bot must have walked towards the player.
    expect(h.facade.moveToPlayerCalls).toHaveLength(1);
    expect(h.facade.moveToPlayerCalls[0]?.player).toBe('Alice');
    // Alice stands at x=6, the bot at x=0: it stops 1.5 blocks short.
    expect(h.facade.getPosition().x).toBeCloseTo(4.5);

    // And the bot must say something back to the player.
    expect(h.facade.chatMessages.length).toBeGreaterThan(0);

    // The planner really ran (exactly one request, not zero and not two).
    expect(h.ai.stats().planned).toBe(1);

    await h.ai.dispose();
  });

  it('runs a deterministic command without touching the planner', async () => {
    const h = harness();

    // "!come" is parsed locally: it must never reach the AI.
    await h.chat('!come');

    expect(h.facade.moveToPlayerCalls).toHaveLength(1);
    expect(h.facade.moveToPlayerCalls[0]?.player).toBe('Alice');
    expect(h.ai.stats().planned).toBe(0);

    await h.ai.dispose();
  });

  it('answers a local command without touching the planner', async () => {
    const h = harness();

    await h.chat('!status');

    expect(h.ai.stats().planned).toBe(0);
    expect(h.facade.chatMessages.some((line) => line.includes('HP 20/20'))).toBe(true);

    await h.ai.dispose();
  });

  it('ignores a command from an unauthorized player', async () => {
    const h = harness();

    await h.chat('follow me', 'Mallory');

    expect(h.ai.stats().planned).toBe(0);
    expect(h.facade.moveToPlayerCalls).toHaveLength(0);
    expect(h.facade.chatMessages).toHaveLength(0);

    await h.ai.dispose();
  });
});
