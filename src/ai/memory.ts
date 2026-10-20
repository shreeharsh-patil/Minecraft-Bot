/**
 * In-memory session state + optional durable JSON persistence.
 *
 * Short-term memory (objective, conversation, recent failures) lives only in
 * RAM and is intentionally cleared on restart. Persistent memory (trusted
 * players, named locations, preferences) is written atomically to
 * `MEMORY_FILE` when configured: write to a temp file, then rename, so a crash
 * mid-write can never leave a truncated memory file behind. Writes are
 * serialised and every write uses its own temp file, so two quick saves can
 * neither overlap nor lose the store.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type {
  MemorySnapshot,
  MemoryStore,
  NamedLocation,
  PersistentMemory,
  PlayerPreference,
  ShortTermMemory,
} from '../types/memory.js';
import { MAX_RECENT_FAILURES, MAX_RECENT_INSTRUCTIONS, MAX_RECENT_LOCATIONS } from '../types/memory.js';
import type { Vec3Like } from '../types/world.js';
import { silentLogger } from '../utils/logger.js';
import type { Logger } from '../utils/logger.js';

/** Rolling chat window shown to the model. */
export const MAX_CONVERSATION_TURNS = 12;

/**
 * Hard ceiling on the durable maps.
 *
 * `!remember <name>` is chat-reachable, so without a cap a player could
 * grow the memory file - and every rewrite of it - without bound.
 */
const MAX_PERSISTENT_ENTRIES = 128;

export interface MemoryStoreOptions {
  /** Path to the durable JSON file. Omit for a pure in-memory store. */
  file?: string;
  /** How many chat turns to keep in the rolling window. */
  conversationTurns?: number;
  logger?: Logger;
  /** Injected clock so tests are deterministic. */
  now?: () => number;
}

/** Keeps only the newest `max` entries. */
function trim<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

/**
 * A map that cannot be reached through the prototype chain.
 *
 * The keys are player-supplied ("constructor", "__proto__"), and a plain
 * object resolves them against Object.prototype: the location called
 * "constructor" was stored under the display name "Object", and
 * "__proto__" replaced the prototype of the map instead of being a key in
 * it - so it was never listed and never written to the file.
 */
function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function emptyPersistent(): PersistentMemory {
  return {
    trustedPlayers: [],
    namedLocations: emptyMap<NamedLocation>(),
    preferences: emptyMap<PlayerPreference>(),
    usefulCoordinates: emptyMap<Vec3Like>(),
  };
}

function emptyShortTerm(conversationTurns: number): ShortTermMemory {
  return {
    objective: null,
    targetPlayer: null,
    recentInstructions: [],
    recentFailures: [],
    recentLocations: [],
    conversation: [],
    conversationTurns,
  };
}

/** Only trust data that structurally matches; a corrupt file must not crash us. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly file: string | undefined;
  private readonly logger: Logger;
  private readonly now: () => number;
  private conversationTurns: number;

  private session: ShortTermMemory;
  private persistent: PersistentMemory;

  /** Tail of the write queue: keeps persistent saves strictly ordered. */
  private writes: Promise<void> = Promise.resolve();

  constructor(options: MemoryStoreOptions = {}) {
    this.file = options.file;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => Date.now());
    this.conversationTurns = Math.max(1, options.conversationTurns ?? MAX_CONVERSATION_TURNS);
    this.session = emptyShortTerm(this.conversationTurns);
    this.persistent = emptyPersistent();
  }

  /** Live session state. Callers must treat it as read-only. */
  public get shortTerm(): ShortTermMemory {
    return this.session;
  }

  // --- session state ---------------------------------------------------------

  public noteInstruction(player: string, text: string): void {
    this.session.recentInstructions = trim(
      [...this.session.recentInstructions, { player, text, at: this.now() }],
      MAX_RECENT_INSTRUCTIONS,
    );
  }

  public noteFailure(action: string, reason: string): void {
    this.session.recentFailures = trim(
      [...this.session.recentFailures, { action, reason, at: this.now() }],
      MAX_RECENT_FAILURES,
    );
  }

  public noteConversation(player: string, text: string): void {
    this.session.conversation = trim(
      [...this.session.conversation, { player, text, at: this.now() }],
      this.conversationTurns,
    );
  }

  public setObjective(objective: string | null): void {
    this.session.objective = objective;
  }

  public setTargetPlayer(player: string | null): void {
    this.session.targetPlayer = player;
  }

// --- named locations ----------------------------------------------------------

  public rememberLocation(name: string, position: Vec3Like): void {
    const key = name.toLowerCase();
    const existing = this.persistent.namedLocations[key];
    const location: NamedLocation = {
      name: existing?.name ?? name,
      position: { x: position.x, y: position.y, z: position.z },
      resolved: true,
      createdAt: existing?.createdAt ?? this.now(),
    };
    this.persistent.namedLocations[key] = location;
    // Keep the session-scoped list bounded by the shared constant.
    this.session.recentLocations = trim(
      [
        ...this.session.recentLocations.filter((entry) => entry.name.toLowerCase() !== key),
        location,
      ],
      MAX_RECENT_LOCATIONS,
    );
    this.pruneLocations(key);
  }

  /**
   * Drops the oldest locations once the durable map is full.
   *
   * The location that was just remembered is never dropped, and neither is
   * one the bot touched during this session: "home" must not disappear
   * because somebody spammed a hundred other names.
   */
  private pruneLocations(keepKey: string): void {
    const locations = this.persistent.namedLocations;
    const keys = Object.keys(locations);
    if (keys.length <= MAX_PERSISTENT_ENTRIES) return;
    const recent = new Set(this.session.recentLocations.map((entry) => entry.name.toLowerCase()));
    const oldestFirst = keys
      .filter((key) => key !== keepKey && !recent.has(key))
      .sort((a, b) => (locations[a]?.createdAt ?? 0) - (locations[b]?.createdAt ?? 0));
    const excess = keys.length - MAX_PERSISTENT_ENTRIES;
    for (const key of oldestFirst.slice(0, excess)) {
      delete locations[key];
    }
    this.logger.warn('too many remembered locations, the oldest were dropped', {
      limit: MAX_PERSISTENT_ENTRIES,
    });
  }

  public recallLocation(name: string): NamedLocation | undefined {
    return this.persistent.namedLocations[name.toLowerCase()];
  }

  public listLocations(): NamedLocation[] {
    return Object.values(this.persistent.namedLocations);
  }

  // --- preferences -------------------------------------------------------------

  public setPreference(key: string, value: string): void {
    const normalized = key.toLowerCase();
    const preference: PlayerPreference = { key: normalized, value, updatedAt: this.now() };
    this.persistent.preferences[normalized] = preference;
    this.prunePreferences(normalized);
  }

  /** Drops the oldest preferences once the durable map is full. */
  private prunePreferences(keepKey: string): void {
    const preferences = this.persistent.preferences;
    const keys = Object.keys(preferences);
    if (keys.length <= MAX_PERSISTENT_ENTRIES) return;
    const oldestFirst = keys
      .filter((key) => key !== keepKey)
      .sort((a, b) => (preferences[a]?.updatedAt ?? 0) - (preferences[b]?.updatedAt ?? 0));
    const excess = keys.length - MAX_PERSISTENT_ENTRIES;
    for (const key of oldestFirst.slice(0, excess)) {
      delete preferences[key];
    }
    this.logger.warn('too many preferences, the oldest were dropped', {
      limit: MAX_PERSISTENT_ENTRIES,
    });
  }

  public getPreference(key: string): string | undefined {
    return this.persistent.preferences[key.toLowerCase()]?.value;
  }

  // --- trust -------------------------------------------------------------------

  public isTrusted(player: string): boolean {
    const key = player.toLowerCase();
    return this.persistent.trustedPlayers.some((entry) => entry.toLowerCase() === key);
  }

  public addTrusted(player: string): void {
    const key = player.toLowerCase();
    if (this.isTrusted(key)) return;
    if (this.persistent.trustedPlayers.length >= MAX_PERSISTENT_ENTRIES) {
      // Fail closed: a trusted player is never dropped to make room for a
      // new one - that would silently take a player's permissions away.
      this.logger.warn('trusted player limit reached, player not added', {
        limit: MAX_PERSISTENT_ENTRIES,
      });
      return;
    }
    this.persistent.trustedPlayers = [...this.persistent.trustedPlayers, key];
  }

  // --- snapshot / persistence ---------------------------------------------------

  public snapshot(): MemorySnapshot {
    return {
      shortTerm: {
        ...this.session,
        recentInstructions: [...this.session.recentInstructions],
        recentFailures: [...this.session.recentFailures],
        recentLocations: [...this.session.recentLocations],
        conversation: [...this.session.conversation],
      },
      persistent: {
        trustedPlayers: [...this.persistent.trustedPlayers],
        namedLocations: { ...this.persistent.namedLocations },
        preferences: { ...this.persistent.preferences },
        usefulCoordinates: { ...this.persistent.usefulCoordinates },
      },
    };
  }

  /** Clears everything, session and durable. */
  public reset(): void {
    this.session = emptyShortTerm(this.conversationTurns);
    this.persistent = emptyPersistent();
  }

  /** No-op when no file is configured. */
  public async persist(): Promise<void> {
    if (this.file === undefined) return;
    const file = this.file;
    const payload = `${JSON.stringify({ version: 1, persistent: this.persistent }, null, 2)}\n`;
    // Writes are SERIALISED: two quick saves must not overlap. Sharing one
    // temp file made the second rename fail (the temp file was already
    // gone), and a half-written file is then treated as corrupt - which
    // loses ALL persistent memory.
    const write = this.writes.then(() => this.writeAtomically(file, payload));
    // A failed write must not poison the chain: later saves still work.
    this.writes = write.catch(() => undefined);
    await write;
  }

  /**
   * Writes the payload to a unique temp file and renames it over the target.
   *
   * The temp name is unique per write, so two overlapping saves can never
   * share (and clobber) the same staging file.
   */
  private async writeAtomically(file: string, payload: string): Promise<void> {
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temp, payload, 'utf8');
      // Atomic on every platform we target: rename replaces in one step.
      await rename(temp, file);
    } catch (error) {
      // Never leave a staging file behind.
      await rm(temp, { force: true }).catch(() => undefined);
      this.logger.error('memory persist failed', {
        file,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** No-op when no file is configured or the file does not exist yet. */
  public async load(): Promise<void> {
    if (this.file === undefined) return;
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return;
      this.logger.error('memory load failed', {
        file: this.file,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      const root = isRecord(parsed) ? parsed : undefined;
      const persistent = isRecord(root?.['persistent']) ? root['persistent'] : undefined;
      if (persistent === undefined) {
        this.logger.warn('memory file has no persistent section, ignoring', { file: this.file });
        return;
      }
      this.persistent = {
        trustedPlayers: readStringArray(persistent['trustedPlayers']),
        namedLocations: readLocations(persistent['namedLocations']),
        preferences: readPreferences(persistent['preferences']),
        usefulCoordinates: readCoordinates(persistent['usefulCoordinates']),
      };
    } catch (error) {
      // A corrupt file must not stop the bot from starting.
      this.logger.error('memory file is corrupt, starting fresh', {
        file: this.file,
        error: error instanceof Error ? error.message : String(error),
      });
      this.persistent = emptyPersistent();
    }
  }
}

// --- defensive parsing helpers ---------------------------------------------------

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT';
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function readLocations(value: unknown): Record<string, NamedLocation> {
  if (!isRecord(value)) return emptyMap<NamedLocation>();
  const out = emptyMap<NamedLocation>();
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const position = entry['position'];
    if (!isRecord(position)) continue;
    const x = position['x'];
    const y = position['y'];
    const z = position['z'];
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') continue;
    const name = typeof entry['name'] === 'string' ? entry['name'] : key;
    const createdAt = typeof entry['createdAt'] === 'number' ? entry['createdAt'] : 0;
    out[key.toLowerCase()] = {
      name,
      position: { x, y, z },
      resolved: entry['resolved'] !== false,
      createdAt,
    };
  }
  return out;
}

function readPreferences(value: unknown): Record<string, PlayerPreference> {
  if (!isRecord(value)) return emptyMap<PlayerPreference>();
  const out = emptyMap<PlayerPreference>();
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const prefValue = entry['value'];
    if (typeof prefValue !== 'string') continue;
    const updatedAt = typeof entry['updatedAt'] === 'number' ? entry['updatedAt'] : 0;
    out[key.toLowerCase()] = { key: key.toLowerCase(), value: prefValue, updatedAt };
  }
  return out;
}

function readCoordinates(value: unknown): Record<string, Vec3Like> {
  if (!isRecord(value)) return emptyMap<Vec3Like>();
  const out = emptyMap<Vec3Like>();
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const x = entry['x'];
    const y = entry['y'];
    const z = entry['z'];
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') continue;
    out[key.toLowerCase()] = { x, y, z };
  }
  return out;
}

/** Factory so callers do not need to know the concrete class. */
export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  return new InMemoryMemoryStore(options);
}