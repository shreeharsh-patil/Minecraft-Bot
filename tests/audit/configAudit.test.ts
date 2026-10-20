/**
 * Audit regression tests for `src/config/config.ts`.
 *
 * Every case below fails without the matching fix in config.ts:
 *  - a port with trailing garbage must not be silently truncated;
 *  - millisecond timeouts must stay inside the 32-bit timer range, otherwise
 *    Node clamps them to 1 ms and a "very patient" timeout becomes instant;
 *  - a zero presence timeout must not be accepted (it disconnects at once);
 *  - dangerous opt-outs must be announced at startup instead of being silent.
 */
import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  ConfigError,
  defaultTestEnv,
  int,
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

/** Node clamps a timer delay above 2^31-1 ms to 1 ms (TimeoutOverflowWarning). */
const NODE_MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

describe('config audit - strict port parsing', () => {
  it('rejects a HEALTH_PORT with trailing garbage instead of truncating it', () => {
    // Number.parseInt('8080abc') is 8080 - the bot would open the wrong port.
    const issues = issuesFor(defaultTestEnv({ HEALTH_PORT: '8080abc' }));
    expect(hasIssue(issues, 'HEALTH_PORT must be a port number')).toBe(true);
  });

  it('rejects a platform-injected PORT with trailing garbage as well', () => {
    const issues = issuesFor(defaultTestEnv({ PORT: '10000abc', RENDER: 'true' }));
    expect(hasIssue(issues, 'PORT/HEALTH_PORT must be a port number')).toBe(true);
  });

  it('rejects a fractional port', () => {
    const issues = issuesFor(defaultTestEnv({ HEALTH_PORT: '8080.5' }));
    expect(hasIssue(issues, 'HEALTH_PORT must be a port number')).toBe(true);
  });

  it('still accepts a plain port', () => {
    const config = buildConfig(defaultTestEnv({ HEALTH_PORT: '8080' }));
    expect(config.runtime.healthPort).toBe(8080);
  });
});

describe('config audit - timeout ceilings', () => {
  it('rejects an AI request timeout that Node would clamp to 1 ms', () => {
    const issues = issuesFor(defaultTestEnv({ AI_REQUEST_TIMEOUT_MS: '3000000000' }));
    expect(hasIssue(issues, 'AI_REQUEST_TIMEOUT_MS must be <= 600000')).toBe(true);
  });

  it('rejects a spawn timeout that Node would clamp to 1 ms', () => {
    const issues = issuesFor(defaultTestEnv({ MC_SPAWN_TIMEOUT_MS: '3000000000' }));
    expect(hasIssue(issues, 'MC_SPAWN_TIMEOUT_MS must be <= 600000')).toBe(true);
  });

  it('keeps every accepted timeout below the 32-bit timer clamp', () => {
    const config = buildConfig(
      defaultTestEnv({ AI_REQUEST_TIMEOUT_MS: '600000', MC_SPAWN_TIMEOUT_MS: '600000' }),
    );
    expect(config.ai.requestTimeoutMs).toBe(600_000);
    expect(config.minecraft.spawnTimeoutMs).toBe(600_000);
    expect(config.ai.requestTimeoutMs).toBeLessThan(NODE_MAX_TIMER_DELAY_MS);
    expect(config.minecraft.spawnTimeoutMs).toBeLessThan(NODE_MAX_TIMER_DELAY_MS);
  });

  it('int() rejects a value above its upper bound', () => {
    const issues: string[] = [];
    expect(int({ X: '11' }, 'X', 7, issues, 1, 10)).toBe(7);
    expect(issues[0]).toContain('must be <= 10');
  });
});

describe('config audit - presence timeout', () => {
  it('rejects a zero presence timeout instead of disconnecting at the first check', () => {
    // humanPresence keeps the bot only while `since < timeout`; 0 is never
    // true, so the bot would leave the server seconds after joining.
    const issues = issuesFor(defaultTestEnv({ HUMAN_TIMEOUT_SECONDS: '0' }));
    expect(hasIssue(issues, 'HUMAN_TIMEOUT_SECONDS must be >= 1')).toBe(true);
  });

  it('still accepts the documented default', () => {
    const config = buildConfig(defaultTestEnv());
    expect(config.presence.timeoutSeconds).toBe(60);
  });
});

describe('config audit - warnings for dangerous settings', () => {
  it('warns when safe mode is switched off', () => {
    const config = buildConfig(defaultTestEnv({ DISCONNECT_WITHOUT_HUMANS: 'false' }));
    expect(config.presence.enabled).toBe(false);
    expect(config.warnings.join(' ')).toContain('DISCONNECT_WITHOUT_HUMANS=false');
  });

  it('warns when the global action-rate ceiling is disabled', () => {
    const config = buildConfig(defaultTestEnv({ MAX_ACTIONS_PER_MINUTE: '0' }));
    expect(config.safety.maxActionsPerMinute).toBe(0);
    expect(config.warnings.join(' ')).toContain('MAX_ACTIONS_PER_MINUTE=0');
  });

  it('warns about a username the server will most likely reject', () => {
    const config = buildConfig(defaultTestEnv({ MC_USERNAME: 'My Bot' }));
    expect(config.warnings.join(' ')).toContain('MC_USERNAME');
  });

  it('stays silent for a canonical username and the default limits', () => {
    const config = buildConfig(defaultTestEnv());
    expect(config.warnings).toEqual([]);
  });
});
