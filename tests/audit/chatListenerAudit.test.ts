/**
 * Audit of the chat router/dispatcher.
 *
 * The listener's own header states the rules these tests pin:
 *   - a line that starts with the command prefix is a *command* line: it is
 *     answered locally and never reaches the planner;
 *   - a stop request is honoured first, for authorized players only, and a
 *     stray character around the word must not turn it into a request for
 *     the planner;
 *   - chat from an unlisted player and the bot's own output never become an
 *     instruction;
 *   - the rate-limit budget is charged exactly once per message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChatListener,
  type ChatListenerDeps,
  type ChatMessage,
} from '../../src/chat/chatListener.js';
import { AuthorizationService } from '../../src/safety/permissions.js';
import { buildConfig, defaultTestEnv, type AppConfig } from '../../src/config/config.js';
import { silentLogger } from '../../src/utils/logger.js';
import { ChatResponder } from '../../src/chat/responses.js';
import type { MinecraftFacade } from '../../src/types/facade.js';
import type {
  MemorySnapshot,
  MemoryStore,
  NamedLocation,
  ShortTermMemory,
} from '../../src/types/memory.js';

/**
 * The listener only reads the bot's own username from the facade ("Never
 * treat the bot's own output as an instruction"), so the tests do not need
 * the full world fake.
 */
function fakeFacade(username = 'TestBot'): MinecraftFacade {
  return { username } as unknown as MinecraftFacade;
}

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
  auth: AuthorizationService;
  config: AppConfig;
  lines: string[];
  deps: {
    runDeterministic: ReturnType<typeof vi.fn>;
    handleNaturalLanguage: ReturnType<typeof vi.fn>;
    stopEverything: ReturnType<typeof vi.fn>;
    handleLocal: ReturnType<typeof vi.fn>;
  };
}

function harness(overrides: Record<string, string | undefined> = {}): Harness {
  const config = buildConfig(defaultTestEnv({ AUTHORIZED_PLAYERS: 'Alice,Bob', ...overrides }));
  const auth = new AuthorizationService(config);
  const facade = fakeFacade();
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

  return { listener: new ChatListener(listenerDeps), auth, config, lines, deps };
}

function message(username: string, text: string): ChatMessage {
  return { username, message: text };
}

describe('ChatListener - a prefixed line is a command line, never a request', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('answers a malformed command line locally instead of planning it', () => {
    // The parser cannot turn these into a command (the word does not match
    // the command grammar), so they arrive as plain chat - but they start
    // with the prefix, so they are command lines and must not be planned.
    for (const text of ['!@#$', '!123', '!<script>', `!${'a'.repeat(30)}`]) {
      const route = h.listener.route(message('Alice', text));

      expect(route.kind, text).not.toBe('ai');
      expect(route.kind, text).toBe('usage');
    }
  });

  it('never calls the planner for a malformed command line', async () => {
    for (const text of ['!@#$', '!123', '!<script>']) {
      await h.listener.handle(message('Alice', text));
    }

    expect(h.deps.handleNaturalLanguage).not.toHaveBeenCalled();
    expect(h.deps.runDeterministic).not.toHaveBeenCalled();
    expect(h.deps.handleLocal).not.toHaveBeenCalled();
    // The player is told what happened instead of the bot acting on it.
    expect(h.lines).toHaveLength(3);
    expect(h.lines[0]).toContain('Unknown command');
  });

  it('says nothing at all when an unauthorized player sends one', async () => {
    await h.listener.handle(message('Mallory', '!@#$'));

    expect(h.deps.handleNaturalLanguage).not.toHaveBeenCalled();
    expect(h.lines).toHaveLength(0);
  });
});

describe('ChatListener - a stop request is always honoured', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('honours a stop request that carries stray punctuation', () => {
    // A player who types "!stop!" or "!!stop" is asking the bot to stop.
    // The bot must not keep working, and the line must not reach the
    // planner (a stop request is charged to the provider otherwise).
    for (const text of ['!stop!', '!!stop', '!stop.', '!STOP!', '!stop,']) {
      expect(h.listener.route(message('Alice', text)).kind, text).toBe('stop');
    }
  });

  it('stops the bot for a punctuated stop request', async () => {
    await h.listener.handle(message('Alice', '!stop!'));

    expect(h.deps.stopEverything).toHaveBeenCalledWith('Alice requested stop');
    expect(h.deps.handleNaturalLanguage).not.toHaveBeenCalled();
  });

  it('does not let an unauthorized player stop the bot with punctuation', () => {
    expect(h.listener.route(message('Mallory', '!stop!'))).toEqual({
      kind: 'ignored',
      reason: 'not-authorized',
    });
  });

  it('honours a punctuated stop request even when the player is rate limited', () => {
    const limited = harness({ MAX_COMMANDS_PER_WINDOW: '1' });

    expect(limited.listener.route(message('Alice', '!come')).kind).toBe('deterministic');
    expect(limited.listener.route(message('Alice', '!come'))).toEqual({
      kind: 'ignored',
      reason: 'rate-limited',
    });
    // Stopping can only reduce what the bot does, so it is still honoured.
    expect(limited.listener.route(message('Alice', '!stop!')).kind).toBe('stop');
  });

  it('does not mistake another command for a stop request', () => {
    for (const text of ['!stopwatch', '!stop2', '!stay', '!goto 1 2 3']) {
      expect(h.listener.route(message('Alice', text)).kind, text).not.toBe('stop');
    }
  });
});

describe('ChatListener - the documented behaviour is unchanged', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('still interprets plain chat from an authorized player', async () => {
    expect(h.listener.route(message('Alice', 'build me a house'))).toEqual({
      kind: 'ai',
      text: 'build me a house',
    });

    await h.listener.handle(message('Alice', 'build me a house'));
    expect(h.deps.handleNaturalLanguage).toHaveBeenCalledWith('Alice', 'build me a house');
  });

  it('still answers an unknown command name locally', () => {
    expect(h.listener.route(message('Alice', '!teleport'))).toEqual({
      kind: 'local',
      name: 'teleport',
      args: [],
    });
  });

  it('still answers a malformed deterministic command with a usage error', () => {
    const route = h.listener.route(message('Alice', '!goto 1 2'));

    expect(route.kind).toBe('usage');
    expect(route).toMatchObject({ message: expect.stringContaining('!goto') });
  });

  it('still ignores the bot own output and unlisted players', () => {
    expect(h.listener.route(message('TestBot', '!goto 1 2 3'))).toEqual({
      kind: 'ignored',
      reason: 'self',
    });
    expect(h.listener.route(message('Mallory', 'build me a house'))).toEqual({
      kind: 'ignored',
      reason: 'not-authorized',
    });
  });
});

describe('ChatListener - the rate-limit budget', () => {
  it('charges exactly one command per message, whatever it routes to', () => {
    const h = harness({ MAX_COMMANDS_PER_WINDOW: '50' });

    const start = h.auth.remainingQuota('Alice');
    h.listener.route(message('Alice', 'hello'));
    expect(h.auth.remainingQuota('Alice')).toBe(start - 1);

    // A malformed command line is charged once as well - it is a message.
    const afterChat = h.auth.remainingQuota('Alice');
    h.listener.route(message('Alice', '!@#$'));
    expect(h.auth.remainingQuota('Alice')).toBe(afterChat - 1);
  });

  it('does not charge empty messages, unlisted players or the bot own output', () => {
    const h = harness({ MAX_COMMANDS_PER_WINDOW: '50' });
    const start = h.auth.remainingQuota('Alice');

    h.listener.route(message('Alice', ''));
    h.listener.route(message('Mallory', 'hello'));
    h.listener.route(message('TestBot', 'hello'));

    expect(h.auth.remainingQuota('Alice')).toBe(start);
  });
});
