/**
 * Chat routing: which chat lines may become actions.
 *
 * The listener decides whether a line is a command, a usage error or a
 * request for the planner. These tests pin the rule that a typo or an
 * unknown command name is answered locally and never escalates into a
 * possible world action.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatListener, type ChatListenerDeps, type ChatMessage } from '../../src/chat/chatListener.js';
import { ChatResponder } from '../../src/chat/responses.js';
import { LocalCommands } from '../../src/commands/index.js';
import { AuthorizationService } from '../../src/safety/permissions.js';
import { TaskManager } from '../../src/executor/actionQueue.js';
import { buildConfig, defaultTestEnv, type AppConfig } from '../../src/config/config.js';
import { silentLogger } from '../../src/utils/logger.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import type {
  MemorySnapshot,
  MemoryStore,
  NamedLocation,
  ShortTermMemory,
} from '../../src/types/memory.js';

/** Minimal in-memory MemoryStore; only the calls the listener makes are real. */
class FakeMemory implements MemoryStore {
  public readonly conversations: Array<{ player: string; text: string }> = [];
  public readonly failures: Array<{ action: string; reason: string }> = [];

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
    /* not exercised here */
  }
  public noteFailure(action: string, reason: string): void {
    this.failures.push({ action, reason });
  }
  public noteConversation(player: string, text: string): void {
    this.conversations.push({ player, text });
  }
  public setObjective(): void {
    /* not exercised here */
  }
  public setTargetPlayer(): void {
    /* not exercised here */
  }
  public rememberLocation(): void {
    /* not exercised here */
  }
  public recallLocation(): NamedLocation | undefined {
    return undefined;
  }
  public listLocations(): NamedLocation[] {
    return [];
  }
  public setPreference(): void {
    /* not exercised here */
  }
  public getPreference(): string | undefined {
    return undefined;
  }
  public isTrusted(): boolean {
    return false;
  }
  public addTrusted(): void {
    /* not exercised here */
  }
  public snapshot(): MemorySnapshot {
    return {
      shortTerm: this.shortTerm,
      persistent: {
        trustedPlayers: [],
        namedLocations: {},
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
    this.conversations.length = 0;
    this.failures.length = 0;
  }
}

interface Harness {
  listener: ChatListener;
  config: AppConfig;
  auth: AuthorizationService;
  facade: FakeMinecraftFacade;
  responder: ChatResponder;
  lines: string[];
  deps: {
    runDeterministic: ReturnType<typeof vi.fn>;
    handleNaturalLanguage: ReturnType<typeof vi.fn>;
    stopEverything: ReturnType<typeof vi.fn>;
    handleLocal: ReturnType<typeof vi.fn>;
  };
}

function harness(): Harness {
  const config = buildConfig(defaultTestEnv());
  const auth = new AuthorizationService(config);
  const facade = new FakeMinecraftFacade();
  const lines: string[] = [];
  const responder = new ChatResponder(silentLogger, 0);
  responder.emit = (text: string): void => {
    lines.push(text);
  };
  const memory = new FakeMemory();

  const deps = {
    runDeterministic: vi.fn(() => Promise.resolve()),
    handleNaturalLanguage: vi.fn(() => Promise.resolve()),
    stopEverything: vi.fn(),
    handleLocal: vi.fn(() => Promise.resolve()),
  };

  const listenerDeps: ChatListenerDeps = {
    facade,
    auth,
    responder,
    memory,
    prefix: '!',
    logger: silentLogger,
    runDeterministic: deps.runDeterministic,
    handleNaturalLanguage: deps.handleNaturalLanguage,
    stopEverything: deps.stopEverything,
    handleLocal: deps.handleLocal,
  };

  return { listener: new ChatListener(listenerDeps), config, auth, facade, responder, lines, deps };
}

function message(username: string, text: string): ChatMessage {
  return { username, message: text };
}

describe('ChatListener.route - a malformed command is a usage error', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('does not escalate a malformed deterministic command to the planner', () => {
    const route = h.listener.route(message('Alice', '!goto 1 2'));

    expect(route.kind).toBe('usage');
    expect(route).toMatchObject({ message: expect.stringContaining('!goto') });
  });

  it('does not escalate other malformed deterministic commands either', () => {
    for (const text of ['!goto', '!goto 1 2', '!follow', '!equip', '!drop dirt 0', '!mine']) {
      expect(h.listener.route(message('Alice', text)).kind, text).toBe('usage');
    }
  });

  it('still parses a well-formed deterministic command', () => {
    expect(h.listener.route(message('Alice', '!goto 1 2 3')).kind).toBe('deterministic');
  });
});

describe('ChatListener.route - an unknown command is answered locally', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('routes an unknown command name to the local handler', () => {
    const route = h.listener.route(message('Alice', '!teleport'));

    expect(route).toEqual({ kind: 'local', name: 'teleport', args: [] });
  });

  it('never sends an unknown command to the planner', () => {
    for (const text of ['!teleport', '!gotoo 1 2 3', '!pls build']) {
      expect(h.listener.route(message('Alice', text)).kind, text).not.toBe('ai');
    }
  });
});

describe('ChatListener.handle - malformed and unknown commands', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('replies with the usage error and runs nothing', async () => {
    await h.listener.handle(message('Alice', '!goto 1 2'));

    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain('!goto');
    expect(h.deps.handleNaturalLanguage).not.toHaveBeenCalled();
    expect(h.deps.runDeterministic).not.toHaveBeenCalled();
    expect(h.deps.handleLocal).not.toHaveBeenCalled();
  });

  it('hands an unknown command to the local handler, not to the planner', async () => {
    await h.listener.handle(message('Alice', '!teleport 1 2 3'));

    expect(h.deps.handleLocal).toHaveBeenCalledWith('Alice', 'teleport', ['1', '2', '3']);
    expect(h.deps.handleNaturalLanguage).not.toHaveBeenCalled();
    expect(h.deps.runDeterministic).not.toHaveBeenCalled();
  });
});

describe('LocalCommands - the "Unknown command" reply is reachable', () => {
  it('answers an unknown command name with a hint', async () => {
    const config = buildConfig(defaultTestEnv());
    const lines: string[] = [];
    const responder = new ChatResponder(silentLogger, 0);
    responder.emit = (text: string): void => {
      lines.push(text);
    };

    const local = new LocalCommands({
      facade: new FakeMinecraftFacade(),
      tasks: new TaskManager(silentLogger),
      auth: new AuthorizationService(config),
      memory: new FakeMemory(),
      responder,
      prefix: '!',
      providerStats: () => 'idle',
      runAction: () => Promise.resolve(),
      logger: silentLogger,
    });

    await local.handle('Alice', 'teleport', []);

    expect(lines).toEqual(['Alice, Unknown command: teleport. Try !help']);
  });
});

describe('LocalCommands - the status reply', () => {
  it('reports the rate-limit budget the player has left', async () => {
    const config = buildConfig(defaultTestEnv({ MAX_COMMANDS_PER_WINDOW: '5' }));
    const lines: string[] = [];
    const responder = new ChatResponder(silentLogger, 0);
    responder.emit = (text: string): void => {
      lines.push(text);
    };
    const auth = new AuthorizationService(config);
    // The player has already spent two of their five commands.
    auth.authorize({ username: 'Alice' });
    auth.authorize({ username: 'Alice' });

    const local = new LocalCommands({
      facade: new FakeMinecraftFacade(),
      tasks: new TaskManager(silentLogger),
      auth,
      memory: new FakeMemory(),
      responder,
      prefix: '!',
      providerStats: () => 'idle',
      runAction: () => Promise.resolve(),
      logger: silentLogger,
    });

    await local.handle('Alice', 'status', []);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('3 cmd left');
  });
});

describe('ChatListener - plain chat from an authorized player', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('is interpreted by the planner, so it can produce a real action', async () => {
    // The documented behaviour: plain chat is not inert context, it is a
    // request the planner may turn into a world action.
    expect(h.listener.route(message('Alice', 'build me a house'))).toEqual({
      kind: 'ai',
      text: 'build me a house',
    });

    await h.listener.handle(message('Alice', 'build me a house'));
    expect(h.deps.handleNaturalLanguage).toHaveBeenCalledWith('Alice', 'build me a house');
  });

  it('is never interpreted for an unauthorized player', async () => {
    await h.listener.handle(message('Mallory', 'build me a house'));

    expect(h.deps.handleNaturalLanguage).not.toHaveBeenCalled();
    expect(h.deps.runDeterministic).not.toHaveBeenCalled();
  });
});
