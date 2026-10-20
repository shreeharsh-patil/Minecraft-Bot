/**
 * Configuration loading and validation.
 *
 * Rules:
 *  - every value comes from the environment, nothing is hardcoded;
 *  - secrets must exist but are never logged or echoed;
 *  - startup fails loudly with an actionable message when something is missing.
 */
import { DEFAULT_BOT_PREFIX, PROVIDER_NAMES, type ProviderName } from './constants.js';

export interface MinecraftConfig {
  host: string;
  port: number;
  username: string;
  /** "microsoft" or "offline". Offline is opt-in and isolated. */
  auth: 'microsoft' | 'offline';
  version?: string;
  profilesPath?: string;
  /** How long to wait for the first spawn before the connection attempt fails. */
  spawnTimeoutMs: number;
}

export interface AiProviderConfig {
  name: ProviderName;
  apiKey: string;
  model: string;
}

export interface AiConfig {
  /** Ordered by preference; unconfigured providers are dropped at load time. */
  providers: AiProviderConfig[];
  /** True when the built-in algorithmic planner may stand in for the LLMs. */
  localPlanner: boolean;
  requestTimeoutMs: number;
  /** Optional stronger model used for multi-step planning. */
  planningModel?: string;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  maxConcurrentRequests: number;
}

export interface ChatConfig {
  prefix: string;
  rateLimit: { windowMs: number; maxCommands: number };
}

export interface PresenceConfig {
  enabled: boolean;
  timeoutSeconds: number;
}

export interface SafetyConfig {
  maxActionsPerMinute: number;
  maxMiningBlocksPerTask: number;
  maxBuildBlocksPerTask: number;
  followDistance: number;
}

export interface RuntimeConfig {
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  logFormat: 'pretty' | 'json';
  memoryFile?: string;
  /** Optional keep-alive HTTP port for platform hosts (see src/healthServer.ts). */
  healthPort?: number;
  maxReconnectAttempts: number;
  reconnectBaseDelayMs: number;
}

export interface AppConfig {
  minecraft: MinecraftConfig;
  ai: AiConfig;
  authorizedPlayers: ReadonlySet<string>;
  chat: ChatConfig;
  presence: PresenceConfig;
  safety: SafetyConfig;
  runtime: RuntimeConfig;
  /** Non-fatal notices surfaced at startup (e.g. MC_AUTH=offline). Logged, never thrown. */
  warnings: readonly string[];
}

export class ConfigError extends Error {
  public readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export type Env = Record<string, string | undefined>;

export function str(env: Env, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function req(env: Env, key: string, issues: string[]): string {
  const v = str(env, key);
  if (v === undefined) {
    issues.push(`${key} is required (see .env.example)`);
    return '';
  }
  return v;
}

export function int(
  env: Env,
  key: string,
  fallback: number,
  issues: string[],
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const v = str(env, key);
  if (v === undefined) return fallback;
  // Strict: "25565abc" used to parse as 25565 and be accepted silently.
  if (!/^-?\d+$/.test(v.trim())) {
    issues.push(`${key} must be an integer (got "${v}")`);
    return fallback;
  }
  const n = Number.parseInt(v.trim(), 10);
  if (!Number.isFinite(n)) {
    issues.push(`${key} must be an integer (got "${v}")`);
    return fallback;
  }
  if (n < min) {
    issues.push(`${key} must be >= ${min} (got ${n})`);
    return fallback;
  }
  if (n > max) {
    issues.push(`${key} must be <= ${max} (got ${n})`);
    return fallback;
  }
  return n;
}

/**
 * Upper bound for every millisecond timeout that ends up in a `setTimeout`.
 *
 * Node's timers are 32-bit: a delay above 2^31-1 ms is silently clamped to
 * 1 ms (with a TimeoutOverflowWarning), which would turn "very patient"
 * into "instant". Ten minutes is far above any sane setting and far below
 * the clamp.
 */
const MAX_TIMER_MS = 600_000;

export function bool(env: Env, key: string, fallback: boolean, issues: string[]): boolean {
  const v = str(env, key);
  if (v === undefined) return fallback;
  const normalized = v.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  issues.push(`${key} must be a boolean like "true" or "false" (got "${v}")`);
  return fallback;
}

export function oneOf<T extends string>(
  env: Env,
  key: string,
  allowed: readonly T[],
  fallback: T,
  issues: string[],
): T {
  const v = str(env, key);
  if (v === undefined) return fallback;
  const normalized = v.toLowerCase() as T;
  if (!allowed.includes(normalized)) {
    issues.push(`${key} must be one of: ${allowed.join(', ')} (got "${v}")`);
    return fallback;
  }
  return normalized;
}

export function csv(env: Env, key: string): string[] {
  const v = str(env, key);
  if (v === undefined) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
const AI_KEY_BY_PROVIDER: Record<ProviderName, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const AI_MODEL_BY_PROVIDER: Record<ProviderName, string> = {
  openai: 'OPENAI_MODEL',
  gemini: 'GEMINI_MODEL',
  groq: 'GROQ_MODEL',
  openrouter: 'OPENROUTER_MODEL',
};

const DEFAULT_MODEL: Record<ProviderName, string> = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openai/gpt-4o-mini',
};

/**
 * Builds a validated config from an environment map.
 * Exported (rather than only `loadConfig`) so tests can exercise it directly.
 */
export function buildConfig(env: Env = process.env): AppConfig {
  const issues: string[] = [];
  const warnings: string[] = [];

  const minecraft: MinecraftConfig = {
    host: req(env, 'MC_HOST', issues),
    port: int(env, 'MC_PORT', 25565, issues, 1),
    username: req(env, 'MC_USERNAME', issues),
    auth: oneOf(env, 'MC_AUTH', ['microsoft', 'offline'] as const, 'microsoft', issues),
    ...(str(env, 'MC_VERSION') ? { version: str(env, 'MC_VERSION') } : {}),
    ...(str(env, 'MC_PROFILES_PATH') ? { profilesPath: str(env, 'MC_PROFILES_PATH') } : {}),
    spawnTimeoutMs: int(env, 'MC_SPAWN_TIMEOUT_MS', 60_000, issues, 1_000, MAX_TIMER_MS),
  };

  if (minecraft.port > 65535) {
    issues.push(`MC_PORT must be a valid port number (got ${minecraft.port})`);
    minecraft.port = 25565;
  }

  if (minecraft.username && !/^[A-Za-z0-9_]{1,16}$/.test(minecraft.username)) {
    // The protocol only accepts 1-16 characters of A-Z, 0-9 and _ (the same
    // rule the command parser applies to player names). Not fatal here - an
    // offline-mode server may still accept it - but the join is rejected by
    // most servers, so say so instead of failing with an opaque kick.
    warnings.push(
      `MC_USERNAME "${minecraft.username}" is not a valid Minecraft username ` +
        '(1-16 characters of A-Z, 0-9 and _); the server will most likely reject the join.',
    );
  }

  if (minecraft.auth === 'offline') {
    // Legitimate for offline-mode servers (common on Aternos) but never a
    // silent choice: the warning is logged loudly at startup instead of
    // blocking the bot from starting at all.
    warnings.push(
      'MC_AUTH=offline selected: the bot will connect without Microsoft authentication. ' +
        'Only use this for servers configured for offline mode.',
    );
    // Without a Microsoft session the bot cannot sign its chat, and a server
    // with "enforce-secure-profile" (the default on many Vanilla and Fabric
    // servers) rejects unsigned chat - the bot would connect but stay mute.
    warnings.push(
      'MC_AUTH=offline means the bot sends UNSIGNED chat: servers with ' +
        'enforce-secure-profile=true will reject it. Use MC_AUTH=microsoft for those.',
    );
  }

  const authorized = csv(env, 'AUTHORIZED_PLAYERS');
  if (authorized.length === 0) {
    issues.push(
      'AUTHORIZED_PLAYERS is required - without it nobody can command the bot (comma separated names)',
    );
  }
  const authLower = new Set(authorized.map((n) => n.toLowerCase()));

  if (minecraft.username && authLower.has(minecraft.username.toLowerCase())) {
    issues.push('AUTHORIZED_PLAYERS must not contain the bot username itself');
  }

  const priorityRaw = str(env, 'AI_PROVIDER_PRIORITY') ?? PROVIDER_NAMES.join(',');
  const priority = priorityRaw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ProviderName => (PROVIDER_NAMES as readonly string[]).includes(s));

  if (priority.length === 0) {
    issues.push(`AI_PROVIDER_PRIORITY must list at least one of: ${PROVIDER_NAMES.join(', ')}`);
  }

  const providers: AiProviderConfig[] = [];
  for (const name of priority) {
    const key = str(env, AI_KEY_BY_PROVIDER[name]);
    if (!key) continue; // Not configured - simply not used.
    providers.push({
      name,
      apiKey: key,
      model: str(env, AI_MODEL_BY_PROVIDER[name]) ?? DEFAULT_MODEL[name],
    });
  }

  /**
   * The algorithmic planner keeps the bot useful with zero API keys. Default
   * on: no excuse for a `ConfigError` when the bot can still plan locally.
   */
  const localPlanner = bool(env, 'AI_LOCAL_PLANNER', true, issues);

  if (providers.length === 0 && !localPlanner) {
    issues.push(
      `No usable AI provider. Set at least one API key: ${
        priority.map((p) => AI_KEY_BY_PROVIDER[p]).join(', ') || '(none selected)'
      }, or set AI_LOCAL_PLANNER=true to use the built-in algorithmic planner without keys.`,
    );
  }
  if (providers.length === 0 && localPlanner) {
    warnings.push(
      'No AI provider API keys found - the built-in algorithmic planner will handle ' +
        'chat requests entirely offline (AI_LOCAL_PLANNER=true by default).',
    );
  }

  const planningModel = str(env, 'AI_PLANNING_MODEL');

  const ai: AiConfig = {
    providers,
    localPlanner,
    requestTimeoutMs: int(env, 'AI_REQUEST_TIMEOUT_MS', 20_000, issues, 500, MAX_TIMER_MS),
    ...(planningModel ? { planningModel } : {}),
    circuitFailureThreshold: int(env, 'AI_CIRCUIT_FAILURE_THRESHOLD', 3, issues, 1),
    circuitCooldownMs: int(env, 'AI_CIRCUIT_COOLDOWN_MS', 60_000, issues, 1_000),
    maxConcurrentRequests: int(env, 'AI_MAX_CONCURRENT_REQUESTS', 2, issues, 1),
  };

  const prefix = str(env, 'BOT_PREFIX') ?? DEFAULT_BOT_PREFIX;

  const chat: ChatConfig = {
    prefix,
    rateLimit: {
      windowMs: 10_000,
      maxCommands: int(env, 'MAX_COMMANDS_PER_WINDOW', 8, issues, 1),
    },
  };

  const presence: PresenceConfig = {
    enabled: bool(env, 'DISCONNECT_WITHOUT_HUMANS', true, issues),
    // 0 would disconnect the bot at the very first presence check, so the
    // switch that turns safe mode off is DISCONNECT_WITHOUT_HUMANS=false -
    // not a zero-second timeout.
    timeoutSeconds: int(env, 'HUMAN_TIMEOUT_SECONDS', 60, issues, 1),
  };

  if (!presence.enabled) {
    // The bot is explicitly not an AFK keep-alive: it must leave an idle
    // server on its own. Opting out is legitimate (a server that is always
    // on), but it is exactly the setting that turns the bot into a keep-alive,
    // so it is announced at startup.
    warnings.push(
      'DISCONNECT_WITHOUT_HUMANS=false: the bot will NOT leave an idle server on its ' +
        'own. Only use this when the server is always on.',
    );
  }

  const safety: SafetyConfig = {
    maxActionsPerMinute: int(env, 'MAX_ACTIONS_PER_MINUTE', 120, issues, 0),
    maxMiningBlocksPerTask: int(env, 'MAX_MINING_BLOCKS_PER_TASK', 512, issues, 1),
    maxBuildBlocksPerTask: int(env, 'MAX_BUILD_BLOCKS_PER_TASK', 256, issues, 1),
    followDistance: int(env, 'FOLLOW_DISTANCE', 3, issues, 1),
  };

  if (safety.maxActionsPerMinute === 0) {
    // 0 is documented as "no limit", but the rate ceiling is the last guard
    // against a runaway or hallucinated plan, so switching it off is said
    // out loud.
    warnings.push(
      'MAX_ACTIONS_PER_MINUTE=0: the global action-rate ceiling is disabled, so a ' +
        'runaway or hallucinated plan is no longer throttled.',
    );
  }

  // Platform keep-alive: Render (and similar hosts) inject `PORT` and expect
  // an open HTTP port. HEALTH_PORT overrides the injected value explicitly.
  // The generic PORT variable is only honoured when a platform marker is
  // present: on a normal machine an unrelated PORT (a dev server, a proxy)
  // would otherwise make the bot open an HTTP listener nobody asked for.
  const platformMarkers = ['RENDER', 'DYNO', 'HEROKU', 'RAILWAY_ENVIRONMENT', 'FLY_APP_NAME'];
  const onPlatform = platformMarkers.some((marker) => str(env, marker) !== undefined);
  const platformPort = onPlatform ? str(env, 'PORT') : undefined;
  const healthPortRaw = str(env, 'HEALTH_PORT') ?? platformPort;
  let healthPort: number | undefined;
  if (healthPortRaw !== undefined) {
    // Strict, like every other number here: `Number.parseInt('8080abc')` is
    // 8080, so a typo would silently open the wrong port. Only a plain
    // integer in the TCP range is accepted.
    const parsed = /^\d+$/.test(healthPortRaw) ? Number.parseInt(healthPortRaw, 10) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      issues.push(
        `${healthPortRaw === platformPort ? 'PORT/HEALTH_PORT' : 'HEALTH_PORT'} must be a port number between 1 and 65535 (got "${healthPortRaw}")`,
      );
    } else {
      healthPort = parsed;
    }
  }

  const runtime: RuntimeConfig = {
    logLevel: oneOf(
      env,
      'LOG_LEVEL',
      ['debug', 'info', 'warn', 'error', 'silent'] as const,
      'info',
      issues,
    ),
    logFormat: oneOf(env, 'LOG_FORMAT', ['pretty', 'json'] as const, 'pretty', issues),
    ...(str(env, 'MEMORY_FILE') ? { memoryFile: str(env, 'MEMORY_FILE') } : {}),
    ...(healthPort !== undefined ? { healthPort } : {}),
    maxReconnectAttempts: int(env, 'MAX_RECONNECT_ATTEMPTS', 5, issues, 0),
    reconnectBaseDelayMs: int(env, 'RECONNECT_BASE_DELAY_MS', 5_000, issues, 100),
  };

  if (issues.length > 0) throw new ConfigError(issues);

  return { minecraft, ai, authorizedPlayers: authLower, chat, presence, safety, runtime, warnings };
}

/** Reads `.env` then validates. Called once from `src/index.ts`. */
export async function loadConfig(env: Env = process.env): Promise<AppConfig> {
  const { config } = await import('dotenv');
  config({ quiet: true });
  return buildConfig(env);
}

/** Case-insensitive authorization check. */
export function isAuthorized(config: AppConfig, username: string): boolean {
  return config.authorizedPlayers.has(username.toLowerCase());
}

/** Test helper producing a valid env with targeted overrides. */
export function defaultTestEnv(overrides: Env = {}): Env {
  return {
    MC_HOST: 'localhost',
    MC_PORT: '25565',
    MC_USERNAME: 'TestBot',
    MC_AUTH: 'microsoft',
    AUTHORIZED_PLAYERS: 'Alice,Bob',
    GROQ_API_KEY: 'test-groq-key',
    AI_PROVIDER_PRIORITY: 'groq',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}