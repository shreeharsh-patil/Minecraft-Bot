/**
 * Authorization: who is allowed to issue orders.
 *
 * Two independent gates:
 *  1. an allowlist of authorized usernames (AUTHORIZED_PLAYERS);
 *  2. a per-player rate limit so one person cannot flood the bot.
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
  /** Mutable at runtime so `!trust` can promote a player. */
  private readonly allowed: Set<string>;
  private readonly windowMs: number;
  private readonly maxCommands: number;
  /** player -> timestamps of recent commands (sliding window). */
  private readonly hits = new Map<string, number[]>();
  private readonly trustedMemory: { isTrusted(name: string): boolean };

  constructor(config: AppConfig, trustedMemory?: { isTrusted(name: string): boolean }) {
    this.allowed = new Set(config.authorizedPlayers);
    this.windowMs = config.chat.rateLimit.windowMs;
    this.maxCommands = config.chat.rateLimit.maxCommands;
    this.trustedMemory = trustedMemory ?? { isTrusted: () => false };
  }

  /** Static allowlist check - does not consume rate limit budget. */
  isAuthorized(username: string): boolean {
    return this.allowed.has(username.toLowerCase()) || this.trustedMemory.isTrusted(username);
  }

  /** Adds an authorized player at runtime (e.g. `!trust Player`). */
  addAuthorized(username: string): void {
    this.allowed.add(username.toLowerCase());
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