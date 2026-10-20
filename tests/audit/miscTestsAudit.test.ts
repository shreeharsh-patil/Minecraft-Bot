/**
 * Regression net for the defects found while auditing the executor, commands,
 * config, bot, health-server and integration test suites.
 *
 * Every test here pins a behaviour that the audit had to repair, so a
 * regression in the source shows up here even if the test that was fixed is
 * rewritten again later.
 *
 * The findings behind each block:
 *  1. the integration test handed the chat line straight to the listener, so
 *     the mineflayer event hop (where the bot used to go mute) was untested;
 *  2. the integration test's request handler skipped the "cancel what is in
 *     flight before planning" step, so a manager that is permanently aborted
 *     by a cancel - the "the AI manager is bricked by the first request" bug -
 *     would still have passed;
 *  3. the bot-event test claimed to ignore system messages, but the wiring
 *     never looks at the position: the sender is the only gate;
 *  4. an over-long coordinate was asserted with a tautology that could not
 *     fail;
 *  5. the deterministic command list skipped `stay` and `pickup`;
 *  6. a task message was "tested" through the silent logger, so nothing about
 *     it could ever fail;
 *  7. the keep-alive endpoint claims to answer ANY request, but only
 *     `GET /` was ever asked;
 *  8. the "no deterministic command reaches the AI" test sent more commands
 *     than the per-player rate limit allows, so the tail of the list was
 *     answered "rate-limited" and could never fail.
 */
import { describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { wireBotEvents } from '../../src/bot/events.js';
import { ChatListener } from '../../src/chat/chatListener.js';
import { ChatResponder } from '../../src/chat/responses.js';
import { toAction, DETERMINISTIC_COMMANDS } from '../../src/chat/commandParser.js';
import { AIManager } from '../../src/ai/AIManager.js';
import { buildCompactContext, type WorldContextSource } from '../../src/ai/contextBuilder.js';
import { createMemoryStore } from '../../src/ai/memory.js';
import { ActionExecutor } from '../../src/executor/actionExecutor.js';
import { ActionLimits } from '../../src/safety/actionLimits.js';
import { AntiGriefRules } from '../../src/safety/antiGrief.js';
import { AuthorizationService } from '../../src/safety/permissions.js';
import { TaskManager } from '../../src/executor/actionQueue.js';
import { createSkillRegistry } from '../../src/skills/index.js';
import { startHealthServer } from '../../src/healthServer.js';
import { buildConfig, defaultTestEnv } from '../../src/config/config.js';
import { silentLogger, createLogger } from '../../src/utils/logger.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import type { AiConfig, AppConfig } from '../../src/config/config.js';

const aiConfig: AiConfig = {
  providers: [],
  localPlanner: true,
  requestTimeoutMs: 2_000,
  circuitFailureThreshold: 2,
  circuitCooldownMs: 1_000,
  maxConcurrentRequests: 2,
};

/** The UUID the server sends as the chat sender on 1.19+ (the 1.21.1 shape). */
const ALICE_UUID = '10920508-d5d8-3eed-93d2-92f193afe7d7';

function fakeBot(): { bot: never; emit: (event: string, ...args: unknown[]) => void } {
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
    uuidToUsername: { [ALICE_UUID]: 'Alice' },
  };
  return {
    bot: bot as never,
    emit: (event: string, ...args: unknown[]): void => {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
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

describe('audit - the chat line really arrives through the event hop', () => {
  it('delivers a 1.21.1 chat line to the listener', () => {
    const { bot, emit } = fakeBot();
    const received: Array<{ username: string; message: string }> = [];
    wireBotEvents({
      bot,
      logger: silentLogger,
      onChat: (username, message) => {
        received.push({ username, message });
      },
      onDisconnect: () => undefined,
    });

    // The real payload: the line is rendered with the "<Name> " prefix and the
    // sender argument is a UUID, not a name.
    emit('message', { toString: () => '<Alice> come here' }, 'chat', ALICE_UUID, true);

    expect(received).toEqual([{ username: 'Alice', message: 'come here' }]);
  });

  it('drops a message whose sender cannot be resolved, whatever position it claims', () => {
    // The sender is the only gate. The wiring ignores the position argument
    // entirely (`void position` in src/bot/events.ts), so a message is kept or
    // dropped on the strength of its sender alone.
    for (const position of ['chat', 'system']) {
      const { bot, emit } = fakeBot();
      const onChat = vi.fn();
      wireBotEvents({ bot, logger: silentLogger, onChat, onDisconnect: vi.fn() });

      emit('message', { toString: () => 'Server closed' }, position, undefined, false);

      expect(onChat, position).not.toHaveBeenCalled();
    }
  });
});

describe('audit - a cancelled request does not brick the AI manager', () => {
  it('still plans after the work in flight was cancelled', async () => {
    const facade = new FakeMinecraftFacade({
      players: [{ name: 'Alice', distance: 6, position: { x: 6, y: 64, z: 0 }, authorized: true }],
    });
    const memory = createMemoryStore({ logger: silentLogger });
    const ai = new AIManager({ config: aiConfig, logger: silentLogger });

    // Production cancels everything in flight before every new request
    // (`BotApp.handleNaturalLanguage` -> `stopEverything('new request')`).
    ai.cancelAll('new request');

    const plan = await ai.planDetailed({
      instruction: 'come here',
      requester: 'Alice',
      context: buildCompactContext(worldSource(facade), memory.shortTerm, { logger: silentLogger }),
    });

    expect(plan.actions.map((action) => action.type)).toContain('move_to_player');
    await ai.dispose();
  });

  it('runs the production-shaped request flow: cancel, plan, execute', async () => {
    const facade = new FakeMinecraftFacade({
      players: [{ name: 'Alice', distance: 6, position: { x: 6, y: 64, z: 0 }, authorized: true }],
    });
    const logger = silentLogger;
    const tasks = new TaskManager(logger);
    const memory = createMemoryStore({ logger });
    const executor = new ActionExecutor({
      facade,
      tasks,
      registry: createSkillRegistry(facade),
      limits: new ActionLimits({
        maxActionsPerMinute: 30,
        maxMiningBlocksPerTask: 512,
        maxBuildBlocksPerTask: 512,
        followDistance: 3,
      }),
      antiGrief: new AntiGriefRules(),
      logger,
      say: () => undefined,
    });
    const ai = new AIManager({ config: aiConfig, logger });

    // The exact order production uses: cancel first, then plan, then act.
    ai.cancelAll('new request');
    executor.cancelActivePlan('new request');
    const plan = await ai.planDetailed({
      instruction: 'come here',
      requester: 'Alice',
      context: buildCompactContext(worldSource(facade), memory.shortTerm, { logger }),
    });
    expect(plan.actions.map((action) => action.type)).toContain('move_to_player');
    await executor.runPlan('Alice', plan.actions);

    expect(facade.moveToPlayerCalls).toHaveLength(1);
    expect(facade.moveToPlayerCalls[0]?.player).toBe('Alice');
    await ai.dispose();
  });
});

describe('audit - the deterministic command surface is complete', () => {
  it('rejects an over-long coordinate with the usage message', () => {
    expect(toAction('goto', ['0', '64', '1'.repeat(40)])).toEqual({
      error: 'usage: !goto <x> <y> <z>',
    });
  });

  it('keeps "stay" and "pickup" on the deterministic path', () => {
    expect(DETERMINISTIC_COMMANDS.has('stay')).toBe(true);
    expect(DETERMINISTIC_COMMANDS.has('pickup')).toBe(true);
  });

  it('never sends "!stay" or "!pickup" to the AI', async () => {    const config: AppConfig = buildConfig(defaultTestEnv({ AUTHORIZED_PLAYERS: 'Alice' }));
    const auth = new AuthorizationService(config);
    const facade = new FakeMinecraftFacade();
    const responder = new ChatResponder(silentLogger, 0);
    const memory = createMemoryStore({ logger: silentLogger });
    const handleNaturalLanguage = vi.fn(() => Promise.resolve());
    const runDeterministic = vi.fn(() => Promise.resolve());
    const handleLocal = vi.fn(() => Promise.resolve());

    const listener = new ChatListener({
      facade,
      auth,
      responder,
      memory,
      prefix: '!',
      logger: silentLogger,
      runDeterministic,
      handleNaturalLanguage,
      stopEverything: () => undefined,
      handleLocal,
    });

    expect(listener.route({ username: 'Alice', message: '!stay' })).toMatchObject({
      kind: 'deterministic',
      action: { type: 'wait' },
    });
    expect(listener.route({ username: 'Alice', message: '!pickup dirt' })).toMatchObject({
      kind: 'deterministic',
      action: { type: 'pickup_items' },
    });

    // Dispatched, not just classified: a command that fell through to the
    // local handler would be answered with "unknown command" instead.
    await listener.handle({ username: 'Alice', message: '!stay' });
    await listener.handle({ username: 'Alice', message: '!pickup dirt' });

    expect(handleNaturalLanguage).not.toHaveBeenCalled();
    expect(handleLocal).not.toHaveBeenCalled();
    expect(runDeterministic).toHaveBeenCalledTimes(2);
  });

  it('dispatches every deterministic command instead of rate-limiting it away', () => {
    // The rate limiter must not be able to swallow a command before the
    // listener has dispatched it: a command that comes back "ignored" was
    // never even looked at, so the "no command reaches the AI" guarantee
    // would be vacuous for it.
    const config: AppConfig = buildConfig(
      defaultTestEnv({ AUTHORIZED_PLAYERS: 'Alice', MAX_COMMANDS_PER_WINDOW: '100' }),
    );
    const auth = new AuthorizationService(config);
    const listener = new ChatListener({
      facade: new FakeMinecraftFacade(),
      auth,
      responder: new ChatResponder(silentLogger, 0),
      memory: createMemoryStore({ logger: silentLogger }),
      prefix: '!',
      logger: silentLogger,
      runDeterministic: () => Promise.resolve(),
      handleNaturalLanguage: () => Promise.resolve(),
      stopEverything: () => undefined,
      handleLocal: () => Promise.resolve(),
    });

    const commands = [
      '!come',
      '!goto 1 2 3',
      '!follow Bob',
      '!guard Bob',
      '!stay',
      '!eat',
      '!equip axe',
      '!drop dirt 2',
      '!mine dirt',
      '!deposit dirt',
      '!withdraw dirt 3',
      '!pickup dirt',
    ];
    for (const text of commands) {
      const kind = listener.route({ username: 'Alice', message: text }).kind;
      expect(kind, text).toBe('deterministic');
    }
  });
});

describe('audit - the task manager really reports task messages', () => {
  it('sends the message through the execution context', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      format: 'json',
      sink: (line) => {
        lines.push(line);
      },
    });
    const tasks = new TaskManager(logger);
    const handle = tasks.start({
      owner: 'Alice',
      type: 'move_to_position',
      conflictGroup: 'movement',
    });

    await tasks.execute(handle, (ctx) => {
      ctx.say('on my way');
      return Promise.resolve();
    });

    const spoken = lines
      .map((line) => JSON.parse(line) as { msg?: string; message?: unknown })
      .filter((record) => record.msg === 'task message');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.message).toBe('on my way');
  });
});

describe('audit - the keep-alive endpoint answers any request', () => {
  it('answers any path and any method with 200 ok', async () => {
    const handle = await startHealthServer(0, silentLogger);
    try {
      const probes: ReadonlyArray<readonly [string, string]> = [
        ['/', 'GET'],
        ['/healthz', 'GET'],
        ['/', 'POST'],
      ];
      for (const [path, method] of probes) {
        const response = await new Promise<{ status: number | undefined; body: string }>(
          (resolve, reject) => {
            const req = httpRequest(
              { host: '127.0.0.1', port: handle.port, path, method },
              (res) => {
                let body = '';
                res.on('data', (chunk: Buffer) => {
                  body += chunk.toString();
                });
                res.on('end', () => resolve({ status: res.statusCode, body }));
              },
            );
            req.on('error', reject);
            req.end();
          },
        );
        expect(response.status, `${method} ${path}`).toBe(200);
      }
    } finally {
      await handle.close();
    }
  });
});
