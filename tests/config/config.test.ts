/**
 * Configuration loading and validation.
 *
 * `buildConfig` is the security gate before the process ever opens a socket:
 * an unusable config must fail loudly and list every problem at once, rather
 * than starting a bot nobody can command or one connected with the wrong auth.
 */
import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  ConfigError,
  defaultTestEnv,
  isAuthorized,
  bool,
  csv,
  int,
  str,
  type Env,
} from '../../src/config/config.js';

/** Runs buildConfig expecting a ConfigError, and returns the collected issues. */
function issuesFor(env: Env): string[] {
  try {
    buildConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected buildConfig to throw a ConfigError');
}

function hasIssue(issues: string[], fragment: string): boolean {
  return issues.some((issue) => issue.includes(fragment));
}

describe('buildConfig - platform health port', () => {
  it('keeps no HTTP listener by default', () => {
    const config = buildConfig(defaultTestEnv());
    expect(config.runtime.healthPort).toBeUndefined();
  });

  it('HEALTH_PORT wins over the injected PORT', () => {
    const config = buildConfig(defaultTestEnv({ HEALTH_PORT: '10000', PORT: '3000' }));
    expect(config.runtime.healthPort).toBe(10_000);
  });

  it('falls back to the platform-injected PORT (Render convention)', () => {
    const config = buildConfig(defaultTestEnv({ PORT: '10000', RENDER: 'true' }));
    expect(config.runtime.healthPort).toBe(10_000);
  });

  it('ignores an unrelated PORT when no platform marker is present', () => {
    // A stray PORT (a dev server, a proxy) must not make the bot open a port.
    const config = buildConfig(defaultTestEnv({ PORT: '3000' }));
    expect(config.runtime.healthPort).toBeUndefined();
  });

  it('rejects nonsense ports', () => {
    const issues = issuesFor(defaultTestEnv({ HEALTH_PORT: '70000' }));
    expect(hasIssue(issues, 'HEALTH_PORT must be a port number')).toBe(true);
  });
});

describe('buildConfig - strict numbers', () => {
  it('rejects a port with trailing garbage instead of silently parsing it', () => {
    const issues = issuesFor(defaultTestEnv({ MC_PORT: '25565abc' }));
    expect(hasIssue(issues, 'MC_PORT must be an integer')).toBe(true);
  });

  it('rejects a port outside the valid TCP range', () => {
    const issues = issuesFor(defaultTestEnv({ MC_PORT: '99999' }));
    expect(hasIssue(issues, 'MC_PORT must be a valid port number')).toBe(true);
  });

  it('accepts a normal port', () => {
    const config = buildConfig(defaultTestEnv({ MC_PORT: '25566' }));
    expect(config.minecraft.port).toBe(25_566);
  });
});

describe('buildConfig - happy path', () => {
  it('accepts defaultTestEnv()', () => {
    const config = buildConfig(defaultTestEnv());

    expect(config.minecraft.host).toBe('localhost');
    expect(config.minecraft.port).toBe(25565);
    expect(config.minecraft.username).toBe('TestBot');
    expect(config.minecraft.auth).toBe('microsoft');
    expect([...config.authorizedPlayers]).toEqual(['alice', 'bob']);
    expect(config.chat.prefix).toBe('!');
    expect(config.runtime.logLevel).toBe('silent');
  });

  it('fills defaults for optional values', () => {
    const config = buildConfig(defaultTestEnv());

    expect(config.minecraft.version).toBeUndefined();
    expect(config.ai.planningModel).toBeUndefined();
    expect(config.ai.requestTimeoutMs).toBe(20_000);
    expect(config.ai.circuitFailureThreshold).toBe(3);
    expect(config.ai.circuitCooldownMs).toBe(60_000);
    expect(config.ai.maxConcurrentRequests).toBe(2);
    expect(config.chat.rateLimit).toEqual({ windowMs: 10_000, maxCommands: 8 });
    expect(config.presence).toEqual({ enabled: true, timeoutSeconds: 60 });
    expect(config.safety.maxActionsPerMinute).toBe(120);
    expect(config.safety.maxMiningBlocksPerTask).toBe(512);
    expect(config.safety.maxBuildBlocksPerTask).toBe(256);
    expect(config.safety.followDistance).toBe(3);
    expect(config.runtime.maxReconnectAttempts).toBe(5);
    expect(config.runtime.logFormat).toBe('pretty');
    expect(config.minecraft.spawnTimeoutMs).toBe(60_000);
    expect(config.warnings).toEqual([]);
  });

  it('uses the documented default model for each provider', () => {
    const config = buildConfig(defaultTestEnv());
    expect(config.ai.providers).toEqual([
      { name: 'groq', apiKey: 'test-groq-key', model: 'llama-3.3-70b-versatile' },
    ]);
  });

  it('reads optional fields when supplied', () => {
    const config = buildConfig(
      defaultTestEnv({
        MC_VERSION: '1.21.4',
        MC_PROFILES_PATH: '/srv/mc/profiles',
        AI_PLANNING_MODEL: 'big-model',
        MEMORY_FILE: '/srv/bot/memory.json',
        BOT_PREFIX: '?',
        HUMAN_TIMEOUT_SECONDS: '90',
        DISCONNECT_WITHOUT_HUMANS: 'false',
        MAX_ACTIONS_PER_MINUTE: '30',
        FOLLOW_DISTANCE: '6',
        MAX_RECONNECT_ATTEMPTS: '0',
        LOG_FORMAT: 'json',
        MC_SPAWN_TIMEOUT_MS: '120000',
      }),
    );

    expect(config.minecraft.version).toBe('1.21.4');
    expect(config.minecraft.profilesPath).toBe('/srv/mc/profiles');
    expect(config.ai.planningModel).toBe('big-model');
    expect(config.runtime.memoryFile).toBe('/srv/bot/memory.json');
    expect(config.chat.prefix).toBe('?');
    expect(config.presence).toEqual({ enabled: false, timeoutSeconds: 90 });
    expect(config.safety.maxActionsPerMinute).toBe(30);
    expect(config.safety.followDistance).toBe(6);
    expect(config.runtime.maxReconnectAttempts).toBe(0);
    expect(config.runtime.logFormat).toBe('json');
    expect(config.minecraft.spawnTimeoutMs).toBe(120_000);
  });
});
describe('buildConfig - missing values', () => {
  it('reports every problem in one error instead of failing one at a time', () => {
    const issues = issuesFor({ MC_HOST: undefined, MC_USERNAME: undefined });

    expect(hasIssue(issues, 'MC_HOST is required')).toBe(true);
    expect(hasIssue(issues, 'MC_USERNAME is required')).toBe(true);
    expect(hasIssue(issues, 'AUTHORIZED_PLAYERS is required')).toBe(true);
    // Zero API keys is no longer fatal: the algorithmic planner covers it.
    expect(hasIssue(issues, 'No usable AI provider')).toBe(false);
  });

  it('with no keys and default AI_LOCAL_PLANNER=true, config still builds', () => {
    const config = buildConfig({ MC_HOST: 'localhost', MC_PORT: '25565', MC_USERNAME: 'TestBot', AUTHORIZED_PLAYERS: 'Alice' });
    expect(config.ai.localPlanner).toBe(true);
    expect(config.ai.providers).toHaveLength(0);
  });

  it('formats the ConfigError message with every issue listed', () => {
    let message = '';
    try {
      buildConfig({});
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      message = (error as ConfigError).message;
    }

    expect(message).toContain('Invalid configuration:');
    expect(message).toContain('MC_HOST is required');
    expect(message).toContain('AUTHORIZED_PLAYERS is required');
  });

  it('fails when MC_HOST is missing', () => {
    const issues = issuesFor(defaultTestEnv({ MC_HOST: undefined }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('MC_HOST is required');
  });

  it('treats an empty AUTHORIZED_PLAYERS value as missing', () => {
    const issues = issuesFor(defaultTestEnv({ AUTHORIZED_PLAYERS: '  ,  ,' }));
    expect(hasIssue(issues, 'AUTHORIZED_PLAYERS is required')).toBe(true);
  });

  it('fails when the only selected AI provider has no key', () => {
    const issues = issuesFor(defaultTestEnv({ GROQ_API_KEY: undefined, AI_LOCAL_PLANNER: 'false' }));
    expect(hasIssue(issues, 'No usable AI provider')).toBe(true);
    expect(hasIssue(issues, 'AI_LOCAL_PLANNER')).toBe(true);
  });

  it('starts without any API key when AI_LOCAL_PLANNER stays enabled (default)', () => {
    const config = buildConfig(defaultTestEnv({ GROQ_API_KEY: undefined }));
    expect(config.ai.providers).toHaveLength(0);
    expect(config.ai.localPlanner).toBe(true);
    expect(config.warnings.some((w) => w.includes('algorithmic planner'))).toBe(true);
  });

  it('still requires a key when AI_LOCAL_PLANNER=false', () => {
    expect(() => buildConfig(defaultTestEnv({ GROQ_API_KEY: undefined, AI_LOCAL_PLANNER: 'false' })))
      .toThrow(ConfigError);
  });

  it('surfacing AI_LOCAL_PLANNER=false keeps the old fatal message', () => {
    const issues = issuesFor(defaultTestEnv({ GROQ_API_KEY: undefined, AI_LOCAL_PLANNER: 'false' }));
    expect(hasIssue(issues, 'No usable AI provider')).toBe(true);
  });

  it('fails when AI_PROVIDER_PRIORITY names no known provider', () => {
    const issues = issuesFor(defaultTestEnv({ AI_PROVIDER_PRIORITY: 'ollama,llama' }));
    expect(hasIssue(issues, 'AI_PROVIDER_PRIORITY must list at least one of')).toBe(true);
    // With no providers left, the algorithmic planner still covers the bot.
    expect(hasIssue(issues, 'No usable AI provider')).toBe(false);
  });
});
describe('buildConfig - AI provider selection', () => {
  it('drops providers without a key and keeps priority order', () => {
    const config = buildConfig(
      defaultTestEnv({
        AI_PROVIDER_PRIORITY: 'openai,gemini,groq',
        OPENAI_API_KEY: 'openai-key',
        GEMINI_API_KEY: undefined,
      }),
    );

    expect(config.ai.providers.map((p) => p.name)).toEqual(['openai', 'groq']);
    expect(config.ai.providers[0]?.apiKey).toBe('openai-key');
    expect(config.ai.providers[0]?.model).toBe('gpt-4o-mini');
  });

  it('normalises priority casing and whitespace', () => {
    const config = buildConfig(
      defaultTestEnv({
        AI_PROVIDER_PRIORITY: ' Groq , OPENROUTER ',
        GROQ_API_KEY: 'g',
        OPENROUTER_API_KEY: 'or',
      }),
    );

    expect(config.ai.providers.map((p) => p.name)).toEqual(['groq', 'openrouter']);
    expect(config.ai.providers[1]?.model).toBe('openai/gpt-4o-mini');
  });

  it('ignores unknown names in AI_PROVIDER_PRIORITY', () => {
    const config = buildConfig(
      defaultTestEnv({ AI_PROVIDER_PRIORITY: 'ollama,groq', GROQ_API_KEY: 'g' }),
    );

    expect(config.ai.providers.map((p) => p.name)).toEqual(['groq']);
  });

  it('honours a per-provider model override', () => {
    const config = buildConfig(defaultTestEnv({ GROQ_MODEL: 'llama-3.1-8b' }));
    expect(config.ai.providers[0]?.model).toBe('llama-3.1-8b');
  });
});
describe('buildConfig - deliberate warnings and self-authorization', () => {
  it('surfaces MC_AUTH=offline as a warning, not a fatal issue, so cracked servers can start', () => {
    const config = buildConfig(defaultTestEnv({ MC_AUTH: 'offline' }));

    expect(config.minecraft.auth).toBe('offline');
    // Two warnings: the authentication mode, and the unsigned-chat caveat
    // (a server with enforce-secure-profile rejects unsigned messages).
    expect(config.warnings).toHaveLength(2);
    expect(config.warnings[0]).toContain('MC_AUTH=offline');
    expect(config.warnings[0]).toContain('without Microsoft authentication');
    expect(config.warnings.join(' ')).toContain('UNSIGNED chat');
  });

  it('has no warnings for the default microsoft auth', () => {
    const config = buildConfig(defaultTestEnv());
    expect(config.warnings).toHaveLength(0);
    expect(() => buildConfig(defaultTestEnv())).not.toThrow();
  });

  it('rejects an unknown MC_AUTH value', () => {
    const issues = issuesFor(defaultTestEnv({ MC_AUTH: 'cracked' }));
    expect(hasIssue(issues, 'MC_AUTH must be one of: microsoft, offline')).toBe(true);
  });

  it('refuses a config where the bot authorizes itself', () => {
    const issues = issuesFor(defaultTestEnv({ AUTHORIZED_PLAYERS: 'Alice,testbot' }));
    expect(hasIssue(issues, 'AUTHORIZED_PLAYERS must not contain the bot username itself')).toBe(
      true,
    );
  });

  it('allows a bot username that merely looks similar', () => {
    expect(() => buildConfig(defaultTestEnv({ AUTHORIZED_PLAYERS: 'Alice,TestBot2' }))).not.toThrow();
  });
});
describe('buildConfig - malformed numbers and booleans', () => {
  it('rejects a non-numeric MC_PORT', () => {
    const issues = issuesFor(defaultTestEnv({ MC_PORT: 'not-a-port' }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('MC_PORT must be an integer');
  });

  it('rejects an out-of-range MC_PORT', () => {
    const issues = issuesFor(defaultTestEnv({ MC_PORT: '0' }));
    expect(issues[0]).toContain('MC_PORT must be >= 1');
  });

  it('rejects a non-numeric or too-small MC_SPAWN_TIMEOUT_MS', () => {
    expect(hasIssue(issuesFor(defaultTestEnv({ MC_SPAWN_TIMEOUT_MS: 'soon' })), 'MC_SPAWN_TIMEOUT_MS must be an integer')).toBe(true);
    expect(hasIssue(issuesFor(defaultTestEnv({ MC_SPAWN_TIMEOUT_MS: '500' })), 'MC_SPAWN_TIMEOUT_MS must be >= 1000')).toBe(true);
  });

  it('rejects a non-numeric safety limit', () => {
    const issues = issuesFor(defaultTestEnv({ MAX_ACTIONS_PER_MINUTE: 'lots' }));
    expect(hasIssue(issues, 'MAX_ACTIONS_PER_MINUTE must be an integer')).toBe(true);
  });

  it('rejects a safety limit below its minimum', () => {
    const issues = issuesFor(defaultTestEnv({ MAX_MINING_BLOCKS_PER_TASK: '0' }));
    expect(issues[0]).toContain('MAX_MINING_BLOCKS_PER_TASK must be >= 1');
  });

  it('rejects an unparsable boolean and keeps the fallback', () => {
    const issues = issuesFor(defaultTestEnv({ DISCONNECT_WITHOUT_HUMANS: 'maybe' }));
    expect(issues[0]).toContain('DISCONNECT_WITHOUT_HUMANS must be a boolean');
  });

  it('rejects an unknown LOG_LEVEL / LOG_FORMAT', () => {
    const issues = issuesFor(defaultTestEnv({ LOG_LEVEL: 'verbose', LOG_FORMAT: 'xml' }));
    expect(hasIssue(issues, 'LOG_LEVEL must be one of')).toBe(true);
    expect(hasIssue(issues, 'LOG_FORMAT must be one of')).toBe(true);
  });

  it('accepts the documented boolean spellings', () => {
    for (const value of ['true', '1', 'YES', 'on']) {
      const config = buildConfig(defaultTestEnv({ DISCONNECT_WITHOUT_HUMANS: value }));
      expect(config.presence.enabled).toBe(true);
    }
    for (const value of ['false', '0', 'no', 'OFF']) {
      const config = buildConfig(defaultTestEnv({ DISCONNECT_WITHOUT_HUMANS: value }));
      expect(config.presence.enabled).toBe(false);
    }
  });

  it('falls back to defaults for values that are absent', () => {
    const config = buildConfig(
      defaultTestEnv({ MC_VERSION: undefined, HUMAN_TIMEOUT_SECONDS: undefined }),
    );
    expect(config.minecraft.version).toBeUndefined();
    expect(config.presence.timeoutSeconds).toBe(60);
  });
});
describe('isAuthorized', () => {
  const config = buildConfig(defaultTestEnv({ AUTHORIZED_PLAYERS: 'Alice, Bob_2' }));

  it('matches exactly', () => {
    expect(isAuthorized(config, 'Bob_2')).toBe(true);
    expect(isAuthorized(config, 'Carol')).toBe(false);
  });

  it('is case-insensitive in both directions', () => {
    expect(isAuthorized(config, 'ALICE')).toBe(true);
    expect(isAuthorized(config, 'alice')).toBe(true);
    expect(isAuthorized(config, 'aLiCe')).toBe(true);
    expect(isAuthorized(config, 'bOB_2')).toBe(true);
  });

  it('does not match on partial names', () => {
    expect(isAuthorized(config, 'Ali')).toBe(false);
    expect(isAuthorized(config, 'Alice2')).toBe(false);
    expect(isAuthorized(config, ' Alice')).toBe(false);
  });

  it('rejects an empty username', () => {
    expect(isAuthorized(config, '')).toBe(false);
  });
});

describe('env primitives', () => {
  it('str trims and treats blank values as absent', () => {
    expect(str({ A: '  value  ' }, 'A')).toBe('value');
    expect(str({ A: '   ' }, 'A')).toBeUndefined();
    expect(str({}, 'A')).toBeUndefined();
  });

  it('csv splits, trims and drops empty entries', () => {
    expect(csv({ A: 'a, B ,,c' }, 'A')).toEqual(['a', 'B', 'c']);
    expect(csv({}, 'A')).toEqual([]);
  });

  it('int falls back when absent, and records the issue when invalid', () => {
    const issues: string[] = [];
    expect(int({}, 'X', 7, issues, 1)).toBe(7);
    expect(issues).toHaveLength(0);

    expect(int({ X: 'abc' }, 'X', 7, issues, 1)).toBe(7);
    expect(issues[0]).toContain('must be an integer');

    expect(int({ X: '-3' }, 'X', 7, issues, 1)).toBe(7);
    expect(issues[1]).toContain('must be >= 1');
  });

  it('bool falls back when absent, and records the issue when invalid', () => {
    const issues: string[] = [];
    expect(bool({}, 'X', true, issues)).toBe(true);
    expect(bool({ X: 'off' }, 'X', true, issues)).toBe(false);
    expect(bool({ X: 'maybe' }, 'X', true, issues)).toBe(true);
    expect(issues[0]).toContain('must be a boolean');
  });
});
