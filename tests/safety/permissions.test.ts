/**
 * Authorization: who may command the bot.
 *
 * The allowlist is the only way in, and it comes from the configuration
 * alone. These tests pin that there is no second, runtime promotion path
 * (the old `!trust` handling was dead code that only pretended to exist)
 * and that the rate-limit budget is reportable to the player.
 */
import { describe, expect, it } from 'vitest';
import { AuthorizationService } from '../../src/safety/permissions.js';
import { buildConfig, defaultTestEnv, type AppConfig } from '../../src/config/config.js';

function config(overrides: Record<string, string | undefined> = {}): AppConfig {
  return buildConfig(defaultTestEnv({ AUTHORIZED_PLAYERS: 'Alice,Bob', ...overrides }));
}

describe('AuthorizationService - the allowlist is the only gate', () => {
  it('authorizes the configured players, case-insensitively', () => {
    const auth = new AuthorizationService(config());

    expect(auth.isAuthorized('Alice')).toBe(true);
    expect(auth.isAuthorized('alice')).toBe(true);
    expect(auth.isAuthorized('ALICE')).toBe(true);
    expect(auth.isAuthorized('Mallory')).toBe(false);
  });

  it('has no runtime promotion path', () => {
    // The documented `!trust` promotion was never wired up; the method that
    // pretended to implement it is gone, so nothing can add a player at
    // runtime behind the operator's back.
    const prototype = AuthorizationService.prototype as unknown as Record<string, unknown>;

    expect(Object.getOwnPropertyNames(AuthorizationService.prototype)).not.toContain(
      'addAuthorized',
    );
    expect(prototype['addAuthorized']).toBeUndefined();
  });

  it('ignores a would-be trusted-player source', () => {
    // The old constructor accepted a "trusted memory" store, which was never
    // passed and never populated. It is gone: only the configured allowlist
    // grants access.
    const LegacyAuthorizationService = AuthorizationService as unknown as new (
      config: AppConfig,
      trustedMemory: { isTrusted(name: string): boolean },
    ) => AuthorizationService;
    const auth = new LegacyAuthorizationService(config(), { isTrusted: () => true });

    expect(auth.isAuthorized('Alice')).toBe(true);
    expect(auth.isAuthorized('Mallory')).toBe(false);
  });
});

describe('AuthorizationService - the rate-limit budget', () => {
  it('reports the commands left in the current window', () => {
    const auth = new AuthorizationService(config({ MAX_COMMANDS_PER_WINDOW: '3' }));

    expect(auth.remainingQuota('Alice')).toBe(3);
    expect(auth.authorize({ username: 'Alice' }).allowed).toBe(true);
    expect(auth.remainingQuota('Alice')).toBe(2);
    expect(auth.authorize({ username: 'Alice' }).allowed).toBe(true);
    expect(auth.remainingQuota('Alice')).toBe(1);
  });

  it('never reports a negative budget', () => {
    const auth = new AuthorizationService(config({ MAX_COMMANDS_PER_WINDOW: '1' }));

    expect(auth.authorize({ username: 'Alice' }).allowed).toBe(true);
    expect(auth.authorize({ username: 'Alice' }).allowed).toBe(false);

    expect(auth.remainingQuota('Alice')).toBe(0);
  });
});
