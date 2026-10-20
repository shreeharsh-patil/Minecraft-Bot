/**
 * End-to-end test of the whole request path:
 *
 *   chat message -> ChatListener -> authorization -> planner -> executor -> skill
 *
 * Every layer above was unit tested, but the wiring between them was not: the
 * bot shipped with a chat listener that never received a single message, and
 * an AI manager that was bricked by the first request. This test exercises the
 * real components together, so a break in the chain shows up here.
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
import { buildCompactContext } from '../../src/ai/contextBuilder.js';
import { createMemoryStore } from '../../src/ai/memory.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { silentLogger } from '../../src/utils/logger.js';
import type { AiConfig } from '../../src/config/config.js';
import type { AppConfig } from '../../src/config/config.js';

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

describe('end-to-end: a chat message reaches the world', () => {
  it('runs the requested action and answers the player', async () => {
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
    responder.emit = (text: string) => facade.chat(text);
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
        await executor.runSingle(owner, action);
      },
      handleNaturalLanguage: async (owner, text) => {
        // Mirror the real app: acknowledge first, then act.
        await responder.send(owner, 'Got it, working on it.');
        const plan = await ai.planDetailed({
          instruction: text,
          requester: owner,
          context: buildCompactContext(
            {
              getPosition: () => facade.getPosition(),
              getDimension: () => 'overworld',
              getTimeOfDay: () => 'day',
              getHealth: () => facade.getHealth(),
              getHunger: () => facade.getHunger(),
              getNearbyPlayers: () => facade.getNearbyPlayers(32),
              getNearbyEntities: () => facade.getNearbyEntities(32),
              scanNearbyBlocks: () => facade.scanNearbyBlocks(16),
              getInventory: () => facade.getInventory(),
              heldItem: () => facade.heldItem(),
            },
            { targetPlayer: owner, conversation: [], objective: null },
          ),
        });
        if (plan.actions.length > 0) {
          await executor.runPlan(owner, plan.actions);
        }
      },
      stopEverything: () => {
        ai.cancelAll('stop');
        executor.cancelActivePlan('stop');
      },
      handleLocal: async (owner, name, args) => {
        await local.handle(owner, name, args);
      },
    });

    // A plain chat line from the authorized player must produce an action.
    // "come here" is a one-shot movement: a persistent task (follow) would
    // keep the plan running for its full duration.
    await listener.handle({ username: 'alice', message: 'come here' });

    // The bot must have moved towards the player.
    expect(facade.calls.some((call) => call === 'moveToPosition' || call === 'moveToPlayer')).toBe(true);

    // And the bot must say something back to the player.
    expect(facade.chatMessages.length).toBeGreaterThan(0);

    await ai.dispose();
  });

  it('ignores a command from an unauthorized player', async () => {
    const facade = new FakeMinecraftFacade();
    const logger = silentLogger;
    const responder = new ChatResponder(logger, 0);
    const auth = new AuthorizationService(appConfig);
    const memory = createMemoryStore({ logger });
    const ai = new AIManager({ config: aiConfig, logger });

    let planned = 0;
    const listener = new ChatListener({
      facade,
      responder,
      auth,
      memory,
      prefix: '!',
      logger,
      runDeterministic: () => Promise.resolve(),
      handleNaturalLanguage: () => {
        planned += 1;
        return Promise.resolve();
      },
      stopEverything: () => undefined,
      handleLocal: () => Promise.resolve(),
    });

    await listener.handle({ username: 'mallory', message: 'follow me' });

    expect(planned).toBe(0);
    await ai.dispose();
  });
});
