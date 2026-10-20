/**
 * Aternos-safe presence monitoring.
 *
 * This bot is NOT an AFK/keep-alive tool. The owner starts their own server;
 * the bot connects like a normal client. If no authorized human has been
 * online for HUMAN_TIMEOUT_SECONDS, the bot disconnects itself so it can never
 * be used to hold an idle server awake.
 *
 * Note the timer resets whenever *any authorized human* is online, so a player
 * can idle in chat and the bot will keep working for them.
 *
 * "Online" is an identity question, not a spatial one: the monitor asks the
 * facade for the server's tab list, which also contains players the client
 * has no entity for (they are far away, or their entity has not been spawned
 * yet). A purely spatial scan would report "nobody is here" and hang up on an
 * owner who is online in a mine 200 blocks away.
 */
import type { MinecraftFacade } from '../types/facade.js';
import type { PresenceConfig } from '../config/config.js';
import type { Logger } from '../utils/logger.js';
import { BOT_TIMING } from '../config/constants.js';

export type PresenceReason = 'authorized-human-present' | 'timeout' | 'disabled' | 'disconnected';

export interface PresenceVerdict {
  shouldStay: boolean;
  reason: PresenceReason;
  /** Seconds since an authorized human was last seen. */
  secondsSinceHuman: number | null;
}

/**
 * Radius of the spatial scan used when the facade cannot report the tab
 * list.
 *
 * It asks for EVERY player the client knows about: the server only sends the
 * player entities it tracks, so a fixed radius would only ever cut off
 * owners who are online but far away.
 */
const PRESENCE_SCAN_RADIUS = Number.POSITIVE_INFINITY;

/** A player that is online. A tab-list entry carries no position. */
export interface OnlinePlayer {
  name: string;
}

/**
 * Optional facade capability: every player that is ONLINE on the server.
 *
 * The tab list is the authoritative source for presence - it is the server's
 * own list of connected players, independent of how far away they are.
 */
export interface OnlinePlayerSource {
  getOnlinePlayers?: () => readonly OnlinePlayer[];
}

export class HumanPresenceMonitor {
  private readonly config: PresenceConfig;
  private readonly facade: MinecraftFacade;
  private readonly logger: Logger;
  private readonly isAuthorized: (name: string) => boolean;
  private timer: NodeJS.Timeout | null = null;
  private lastHumanSeen: number | null = null;
  private onDisconnect: ((reason: PresenceReason) => void) | null = null;
  /** Player names we have already greeted, so we stay quiet afterwards. */
  private readonly greeted = new Set<string>();
  private lastVerdict: PresenceVerdict | null = null;

  constructor(
    config: PresenceConfig,
    facade: MinecraftFacade,
    isAuthorized: (name: string) => boolean,
    logger: Logger,
  ) {
    this.config = config;
    this.facade = facade;
    this.isAuthorized = isAuthorized;
    this.logger = logger.child({ component: 'presence' });
  }

  setDisconnectHandler(handler: (reason: PresenceReason) => void): void {
    this.onDisconnect = handler;
  }

  /** Starts the periodic presence check. */
  start(): void {
    if (!this.config.enabled) {
      this.logger.info('Aternos safe mode disabled (DISCONNECT_WITHOUT_HUMANS=false)');
      return;
    }
    if (this.timer !== null) return;
    // Mark the connection time as the reference point; a human must be seen.
    this.lastHumanSeen = Date.now();
    this.timer = setInterval(() => {
      this.check();
    }, BOT_TIMING.PRESENCE_CHECK_MS);
    this.timer.unref();
    this.logger.info('Aternos safe mode active', {
      timeoutSeconds: this.config.timeoutSeconds,
    });
  }

  /** Stops the timer. Called on shutdown so nothing keeps the process alive. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Evaluates presence. Public so tests can drive it without real timers.
   */
  check(now: number = Date.now()): PresenceVerdict {
    if (!this.config.enabled) {
      return this.remember(now, { shouldStay: true, reason: 'disabled', secondsSinceHuman: null });
    }

    const players = this.onlinePlayers();
    let sawAuthorized = false;
    for (const player of players) {
      if (!this.isAuthorized(player.name)) continue;
      sawAuthorized = true;
      this.lastHumanSeen = now;
      if (!this.greeted.has(player.name)) {
        this.greeted.add(player.name);
        this.logger.info('authorized human online', { player: player.name });
      }
    }

    if (sawAuthorized) {
      return this.remember(now, {
        shouldStay: true,
        reason: 'authorized-human-present',
        secondsSinceHuman: 0,
      });
    }

    // No reference point yet (the monitor was never started): the grace
    // period starts now instead of the timeout firing on the very first
    // check and hanging up on a player who is still on their way.
    if (this.lastHumanSeen === null) {
      this.lastHumanSeen = now;
    }

    const since = (now - this.lastHumanSeen) / 1000;
    const timeout = this.config.timeoutSeconds;

    if (since < timeout) {
      return this.remember(now, {
        shouldStay: true,
        reason: 'authorized-human-present',
        secondsSinceHuman: Math.round(since),
      });
    }

    this.logger.warn('no authorized human online - disconnecting', {
      secondsSinceHuman: Math.round(since),
      timeoutSeconds: timeout,
    });
    this.stop();
    this.onDisconnect?.('timeout');
    return this.remember(now, {
      shouldStay: false,
      reason: 'timeout',
      secondsSinceHuman: Math.round(since),
    });
  }

  /**
   * The players that are online right now.
   *
   * The tab list wins over the spatial scan: an authorized human who is
   * online but out of range (or whose entity has not arrived yet) is still
   * online, and a spatial query alone would report "nobody is here".
   */
  private onlinePlayers(): readonly OnlinePlayer[] {
    const source = this.facade as MinecraftFacade & OnlinePlayerSource;
    if (typeof source.getOnlinePlayers === 'function') {
      return source.getOnlinePlayers().filter((player) => !this.isSelf(player.name));
    }
    return this.facade
      .getNearbyPlayers(PRESENCE_SCAN_RADIUS)
      .filter((player) => !this.isSelf(player.name));
  }

  /** The bot is not a human and must never keep the server awake. */
  private isSelf(name: string): boolean {
    return name.toLowerCase() === this.facade.username.toLowerCase();
  }

  /** Called when the bot disconnects for any reason. */
  noteDisconnected(): void {
    this.stop();
  }

  getLastHumanSeen(): number | null {
    return this.lastHumanSeen;
  }

  /** Test helper: pretend an authorized player was just seen. */
  markHumanSeen(now: number = Date.now()): void {
    this.lastHumanSeen = now;
  }

  resetGreetings(): void {
    this.greeted.clear();
  }

  getVerdict(): PresenceVerdict | null {
    return this.lastVerdict;
  }

  private remember(now: number, verdict: PresenceVerdict): PresenceVerdict {
    void now;
    this.lastVerdict = verdict;
    return verdict;
  }
}