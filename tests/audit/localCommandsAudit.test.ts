/**
 * Audit of the deterministic local commands (`src/commands/index.ts`).
 *
 * The local commands answer in chat with no AI involvement and they own the
 * remembered locations. The tests below pin the behaviour the fixes in that
 * file introduced:
 *
 *  - a location name that would corrupt the persistent location record is
 *    refused instead of being silently lost;
 *  - the set of remembered locations is bounded;
 *  - an unconfirmed (unresolved) location is never walked to;
 *  - the "no home yet" hint names a command the bot really understands.
 */
import { describe, expect, it, vi } from 'vitest';
import { LocalCommands } from '../../src/commands/index.js';
import { ChatResponder } from '../../src/chat/responses.js';
import { COMMAND_SYNTAX } from '../../src/chat/commandParser.js';
import { AuthorizationService } from '../../src/safety/permissions.js';
import { TaskManager } from '../../src/executor/actionQueue.js';
import { createMemoryStore } from '../../src/ai/memory.js';
import { buildConfig, defaultTestEnv } from '../../src/config/config.js';
import { silentLogger } from '../../src/utils/logger.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import type {
  MemorySnapshot,
  MemoryStore,
  NamedLocation,
  ShortTermMemory,
} from '../../src/types/memory.js';
import type { Vec3Like } from '../../src/types/world.js';

/** The same ceiling the native runtime puts on one memory collection. */
const MAX_NAMED_LOCATIONS = 128;

/**
 * Captures the outbound chat lines instead of talking to a server.
 *
 * The real responder is used on purpose: replies still go through
 * `safeChatReply`, so the tests see exactly what a player would see.
 */
class RecordingResponder extends ChatResponder {
  public readonly sent: string[] = [];

  constructor() {
    // 0ms spacing keeps the tests free of real timers.
    super(silentLogger, 0);
    this.emit = (text: string): void => {
      this.sent.push(text);
    };
  }

  /** The reply bodies with the leading `"<target>, "` prefix removed. */
  public bodies(): string[] {
    return this.sent.map((line) => line.replace(/^[^,]+,\s*/, ''));
  }
}

/** A memory store whose locations the test controls exactly. */
class TestMemory implements MemoryStore {
  public readonly locations = new Map<string, NamedLocation>();
  public readonly shortTerm: ShortTermMemory = {
    objective: null,
    targetPlayer: null,
    recentInstructions: [],
    recentFailures: [],
    recentLocations: [],
    conversation: [],
    conversationTurns: 0,
  };

  public noteInstruction(): void {
    /* not used by the local commands */
  }
  public noteFailure(): void {
    /* not used by the local commands */
  }
  public noteConversation(): void {
    /* not used by the local commands */
  }
  public setObjective(): void {
    /* not used by the local commands */
  }
  public setTargetPlayer(): void {
    /* not used by the local commands */
  }

  public rememberLocation(name: string, position: Vec3Like): void {
    this.locations.set(name.toLowerCase(), { name, position, resolved: true, createdAt: 0 });
  }

  public recallLocation(name: string): NamedLocation | undefined {
    return this.locations.get(name.toLowerCase());
  }

  public listLocations(): NamedLocation[] {
    return [...this.locations.values()];
  }

  public setPreference(): void {
    /* not used by the local commands */
  }
  public getPreference(): undefined {
    return undefined;
  }
  public isTrusted(): boolean {
    return false;
  }
  public addTrusted(): void {
    /* not used by the local commands */
  }

  public snapshot(): MemorySnapshot {
    const namedLocations: Record<string, NamedLocation> = {};
    for (const [name, location] of this.locations) namedLocations[name] = location;
    return {
      shortTerm: this.shortTerm,
      persistent: {
        trustedPlayers: [],
        namedLocations,
        preferences: {},
        usefulCoordinates: {},
      },
    };
  }

  public persist(): Promise<void> {
    return Promise.resolve();
  }
  public load(): Promise<void> {
    return Promise.resolve();
  }
  public reset(): void {
    this.locations.clear();
  }
}

interface Harness {
  local: LocalCommands;
  memory: MemoryStore;
  responder: RecordingResponder;
  /** Records the world action a command asked for. */
  runAction: ReturnType<typeof vi.fn>;
}

function harness(memory: MemoryStore = createMemoryStore({ logger: silentLogger })): Harness {
  const config = buildConfig(defaultTestEnv({ AUTHORIZED_PLAYERS: 'Alice' }));
  const responder = new RecordingResponder();
  const runAction: ReturnType<typeof vi.fn> = vi.fn(() => Promise.resolve());

  const local = new LocalCommands({
    facade: new FakeMinecraftFacade({ position: { x: 10, y: 64, z: -5 } }),
    tasks: new TaskManager(silentLogger),
    auth: new AuthorizationService(config),
    memory,
    responder,
    prefix: '!',
    providerStats: () => 'Brain: algorithmic planner (offline).',
    runAction,
    logger: silentLogger,
  });

  return { local, memory, responder, runAction };
}

describe('LocalCommands - the remember command', () => {
  it('remembers a normal place', async () => {
    const h = harness();

    await h.local.handle('Alice', 'remember', ['base']);

    expect(h.responder.bodies()[0]).toContain('Remembered "base"');
    expect(h.memory.recallLocation('base')).toBeDefined();
  });

  it('refuses a location name that would corrupt the location record', async () => {
    // The store keeps locations in a plain object, and `__proto__` is an
    // accessor on Object.prototype: storing it replaces the prototype of the
    // record instead of adding an entry, so the location would never be
    // listed, never be saved - and the record would hand out inherited
    // values for names that are not locations at all.
    const memory = createMemoryStore({ logger: silentLogger });
    const h = harness(memory);

    await h.local.handle('Alice', 'remember', ['__proto__']);

    expect(h.responder.bodies()).toEqual(['"__proto__" is not a usable location name.']);
    // Nothing was stored, and the record still answers only for real
    // locations (an inherited value would show up here).
    expect(memory.listLocations()).toEqual([]);
    expect(memory.recallLocation('name')).toBeUndefined();
  });

  it('refuses to grow the set of remembered locations past the limit', async () => {
    const memory = createMemoryStore({ logger: silentLogger });
    const h = harness(memory);
    for (let index = 0; index < MAX_NAMED_LOCATIONS; index += 1) {
      memory.rememberLocation(`place_${index}`, { x: index, y: 64, z: 0 });
    }

    await h.local.handle('Alice', 'remember', ['one_too_many']);

    expect(h.responder.bodies()[0]).toContain('maximum');
    expect(memory.listLocations()).toHaveLength(MAX_NAMED_LOCATIONS);
  });

  it('still moves a place that is already known when the store is full', async () => {
    const memory = createMemoryStore({ logger: silentLogger });
    const h = harness(memory);
    for (let index = 0; index < MAX_NAMED_LOCATIONS; index += 1) {
      memory.rememberLocation(`place_${index}`, { x: index, y: 64, z: 0 });
    }

    await h.local.handle('Alice', 'remember', ['place_0']);

    expect(h.responder.bodies()[0]).toContain('Remembered "place_0"');
    expect(memory.listLocations()).toHaveLength(MAX_NAMED_LOCATIONS);
  });
});

describe('LocalCommands - the home command', () => {
  it('walks to a confirmed home', async () => {
    const memory = new TestMemory();
    memory.locations.set('home', {
      name: 'home',
      position: { x: 10, y: 64, z: -5 },
      resolved: true,
      createdAt: 0,
    });
    const h = harness(memory);

    await h.local.handle('Alice', 'home', []);

    expect(h.runAction).toHaveBeenCalledWith('Alice', {
      type: 'move_to_position',
      position: { x: 10, y: 64, z: -5 },
    });
  });

  it('never walks to an unconfirmed home', async () => {
    // An unresolved location is a placeholder, not a confirmed place: the
    // native runtime refuses to use one until the player re-remembers it.
    const memory = new TestMemory();
    memory.locations.set('home', {
      name: 'home',
      position: { x: 100, y: 64, z: 100 },
      resolved: false,
      createdAt: 0,
    });
    const h = harness(memory);

    await h.local.handle('Alice', 'home', []);

    expect(h.runAction).not.toHaveBeenCalled();
    expect(h.responder.bodies()[0]).toContain('!remember home');
  });

  it('points at a command the bot really understands when no home is known', async () => {
    const h = harness();

    await h.local.handle('Alice', 'home', []);

    const body = h.responder.bodies()[0] ?? '';
    expect(body).toContain('!remember home');
    // The hint must name a command that exists in the command surface.
    expect(COMMAND_SYNTAX.map((command) => command.name)).toContain('remember');
  });
});
