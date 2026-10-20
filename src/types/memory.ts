/** Short-term (session) and persistent (on-disk) memory shapes. */
import type { Vec3Like } from './world.js';

export interface NamedLocation {
  name: string;
  position: Vec3Like;
  /** Resolved lazily; "home" may mean the world spawn. */
  resolved: boolean;
  createdAt: number;
}

export interface PlayerPreference {
  key: string;
  value: string;
  updatedAt: number;
}

/**
 * Rolling session state - cleared on restart.
 *
 * The rolling windows are bounded (MAX_RECENT_* below) and their CONTENTS
 * are read-only: the store owns the caps, so a caller must not be able to
 * push into a window and grow the session - and the prompt built from it -
 * past them.
 */
export interface ShortTermMemory {
  objective: string | null;
  targetPlayer: string | null;
  /** Most recent instructions, newest last. */
  recentInstructions: ReadonlyArray<{ player: string; text: string; at: number }>;
  /** Recent failures, used to stop the model repeating a mistake. */
  recentFailures: ReadonlyArray<{ action: string; reason: string; at: number }>;
  recentLocations: readonly NamedLocation[];
  /** Rolling chat window shown to the model. */
  conversation: ReadonlyArray<{ player: string; text: string; at: number }>;
  conversationTurns: number;
}

/** Durable state - persisted to disk when MEMORY_FILE is configured. */
export interface PersistentMemory {
  trustedPlayers: string[];
  namedLocations: Record<string, NamedLocation>;
  preferences: Record<string, PlayerPreference>;
  usefulCoordinates: Record<string, Vec3Like>;
}

export interface MemorySnapshot {
  shortTerm: ShortTermMemory;
  persistent: PersistentMemory;
}

export interface MemoryStore {
  /**
   * The live session state.
   *
   * Read-only on purpose: the store keeps every rolling window capped, and
   * this session is what the model is shown, so a caller must not be able
   * to push into it and defeat those caps.
   */
  readonly shortTerm: Readonly<ShortTermMemory>;
  noteInstruction(player: string, text: string): void;
  noteFailure(action: string, reason: string): void;
  noteConversation(player: string, text: string): void;
  setObjective(objective: string | null): void;
  setTargetPlayer(player: string | null): void;

  rememberLocation(name: string, position: Vec3Like): void;
  recallLocation(name: string): NamedLocation | undefined;
  listLocations(): NamedLocation[];

  setPreference(key: string, value: string): void;
  getPreference(key: string): string | undefined;

  isTrusted(player: string): boolean;
  addTrusted(player: string): void;

  snapshot(): MemorySnapshot;
  /** Writes persistent memory; no-op when no file is configured. */
  persist(): Promise<void>;
  load(): Promise<void>;
  reset(): void;
}

export const MAX_RECENT_INSTRUCTIONS = 10;
export const MAX_RECENT_FAILURES = 10;
export const MAX_RECENT_LOCATIONS = 10;