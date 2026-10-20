/**
 * Authorization: who is allowed to issue orders.
 *
 * Two independent gates:
 *  1. an allowlist of authorized usernames (AUTHORIZED_PLAYERS);
 *  2. a per-player rate limit so one person cannot flood the bot.
 *
 * The allowlist comes from the configuration alone: there is no runtime
 * promotion path, so the set of players who can command the bot is exactly
 * the set the operator configured.
 *
 * Unauthorized players may still chat - their messages are simply never
 * turned into instructions.
 */
import type { AppConfig } from '../config/config.js';

export interface AuthorizationDecision {
  allowed: boolean;
  reason?: string;
}

export interface ChatPrincipal {
  username: string;
  /** True when the message came from the bot itself. */
  isSelf?: boolean;
}

export class AuthorizationService {
  /** The authorized usernames, already lower-cased by the config loader. */
  private readonly allowed: Set<string>;
  private readonly windowMs: number;
  private readonly maxCommands: number;
  /** player -> timestamps of recent commands (sliding window). */
  private readonly hits = new Map<string, number[]>();

  constructor(config: AppConfig) {
    // The allowlist is normalised here rather than trusted: the config
    // loader lower-cases the names it parses, but the AppConfig type does
    // not promise that, and an allowlist that is not lower-cased authorises
    // nobody at all. An empty name is dropped for the same reason - it would
    // authorise an empty username.
    this.allowed = new Set(
      [...config.authorizedPlayers]
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    );
    this.windowMs = config.chat.rateLimit.windowMs;
    this.maxCommands = config.chat.rateLimit.maxCommands;
  }

  /** Static allowlist check - does not consume rate limit budget. */
  isAuthorized(username: string): boolean {
    return this.allowed.has(username.toLowerCase());
  }

  /**
   * Full check used before treating a chat line as an instruction.
   * Returns the reason on rejection so the bot can stay quiet or explain.
   */
  authorize(principal: ChatPrincipal): AuthorizationDecision {
    if (principal.isSelf) return { allowed: false, reason: 'self' };
    const name = principal.username;
    if (!this.isAuthorized(name)) {
      return { allowed: false, reason: 'not-authorized' };
    }
    if (!this.consumeRateLimit(name)) {
      return { allowed: false, reason: 'rate-limited' };
    }
    return { allowed: true };
  }

  /** Sliding-window rate limiter. Returns false when the caller is over budget. */
  consumeRateLimit(username: string): boolean {
    const now = Date.now();
    const key = username.toLowerCase();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.maxCommands) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Remaining commands in the current window - used by `!status`. */
  remainingQuota(username: string): number {
    const now = Date.now();
    const recent = (this.hits.get(username.toLowerCase()) ?? []).filter(
      (t) => now - t < this.windowMs,
    );
    return Math.max(0, this.maxCommands - recent.length);
  }

  reset(): void {
    this.hits.clear();
  }
}