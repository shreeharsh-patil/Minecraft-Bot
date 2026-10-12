/**
 * Deterministic command parsing.
 *
 * Pure functions only - no I/O, no game state. `!come`, `!goto 10 64 -5`
 * never reach an LLM; they are matched here and dispatched directly.
 */
import type { BotAction } from '../types/actions.js';

export interface ParsedCommand {
  name: string;
  args: string[];
  /** Raw text after the prefix. */
  raw: string;
}

export interface ParseResult {
  kind: 'command' | 'empty' | 'chat';
  command?: ParsedCommand;
  /** The text itself, for 'chat' results. */
  text: string;
}

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;

/** Strips the bot prefix and normalises whitespace. */
export function parseInput(message: string, prefix: string): ParseResult {
  const trimmed = message.trim();
  if (trimmed.length === 0) return { kind: 'empty', text: '' };
  if (!trimmed.startsWith(prefix)) return { kind: 'chat', text: trimmed };

  const body = trimmed.slice(prefix.length).trim();
  if (body.length === 0) return { kind: 'empty', text: '' };

  const [head = '', ...args] = body.split(/\s+/);
  const name = head.toLowerCase();
  if (!NAME_PATTERN.test(name)) {
    // Malformed prefix usage is treated as plain chat, never as a command.
    return { kind: 'chat', text: trimmed };
  }
  return { kind: 'command', text: trimmed, command: { name, args, raw: body } };
}

/** Parses a finite integer, rejecting NaN/Infinity/exponents. */
export function parseInteger(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^-?\d{1,12}$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/** Parses one or more integers (coordinates). */
export function parseIntegers(values: string[]): number[] | null {
  const out: number[] = [];
  for (const v of values) {
    const n = parseInteger(v);
    if (n === null) return null;
    out.push(n);
  }
  return out.length > 0 ? out : null;
}

/** Minecraft usernames are alphanumeric + underscore, 1..16 chars. */
export function parsePlayerName(value: string | undefined): string | null {
  if (value === undefined) return null;
  return /^[A-Za-z0-9_]{1,16}$/.test(value) ? value : null;
}

/** Count must be a positive integer within reason. */
export function parseCount(value: string | undefined, max = 10_000): number | null {
  const n = parseInteger(value);
  if (n === null || n <= 0 || n > max) return null;
  return n;
}

const ITEM_RE = /^[a-z0-9_]{1,64}$/;

/** Named locations, e.g. "home". */
function parseName(value: string | undefined): string | null {
  if (value === undefined) return null;
  return /^[a-z0-9_]{1,32}$/.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

function isItem(value: string | undefined): value is string {
  return value !== undefined && ITEM_RE.test(value.toLowerCase());
}
/**
 * Converts a deterministic command into the same validated action shape the
 * AI produces, so both paths funnel through one executor.
 */
export function toAction(name: string, args: string[]): BotAction | { error: string } {
  switch (name) {
    case 'come':
      // Filled in by the caller with the requesting player's name.
      return { type: 'move_to_player', player: '' };

    case 'goto': {
      const coords = parseIntegers(args.slice(0, 3));
      if (!coords || coords.length !== 3) {
        return { error: 'usage: !goto <x> <y> <z>' };
      }
      const [x, y, z] = coords;
      if (x === undefined || y === undefined || z === undefined) {
        return { error: 'usage: !goto <x> <y> <z>' };
      }
      return { type: 'move_to_position', position: { x, y, z } };
    }

    case 'follow': {
      const player = parsePlayerName(args[0]);
      if (!player) return { error: 'usage: !follow <player>' };
      const distance = args[1] !== undefined ? parseInteger(args[1]) : null;
      return {
        type: 'follow_player',
        player,
        ...(distance !== undefined && distance !== null && distance > 0 ? { distance } : {}),
      };
    }

    case 'guard': {
      const player = parsePlayerName(args[0]);
      if (!player) return { error: 'usage: !guard <player>' };
      return { type: 'defend_player', player, radius: 8 };
    }

    case 'stop':
      return { type: 'stop' };

    case 'stay':
      // Hold position: stop any movement where the bot already is.
      return { type: 'wait', durationMs: 1 };

    case 'eat': {
      if (args[0] !== undefined && !isItem(args[0])) return { error: 'invalid item name' };
      const item = args[0]?.toLowerCase();
      return { type: 'eat', ...(item !== undefined ? { item } : {}) };
    }

    case 'equip': {
      if (!isItem(args[0])) return { error: 'usage: !equip <item>' };
      return { type: 'equip_item', item: args[0].toLowerCase() };
    }

    case 'drop': {
      if (!isItem(args[0])) return { error: 'usage: !drop <item> [count]' };
      const count = args[1] !== undefined ? parseCount(args[1], 2304) : null;
      if (args[1] !== undefined && count === null) return { error: 'count must be a positive integer' };
      return {
        type: 'drop_item',
        item: args[0].toLowerCase(),
        ...(count !== null ? { count } : {}),
      };
    }

    case 'mine': {
      if (!isItem(args[0])) return { error: 'usage: !mine <block> [count]' };
      const count = args[1] !== undefined ? parseCount(args[1]) : 16;
      if (count === null) return { error: 'count must be a positive integer' };
      return { type: 'mine_block', blockName: args[0].toLowerCase(), count };
    }

    case 'deposit': {
      if (args[0] !== undefined && !isItem(args[0])) return { error: 'invalid item name' };
      const item = args[0]?.toLowerCase();
      return { type: 'deposit_items', ...(item !== undefined ? { item } : {}) };
    }

    case 'withdraw': {
      if (args[0] !== undefined && !isItem(args[0])) return { error: 'invalid item name' };
      const item = args[0]?.toLowerCase();
      const count = args[1] !== undefined ? parseCount(args[1], 2304) : null;
      if (args[1] !== undefined && count === null) return { error: 'count must be a positive integer' };
      return {
        type: 'withdraw_items',
        ...(item !== undefined ? { item } : {}),
        ...(count !== null ? { count } : {}),
      };
    }

    case 'pickup': {
      if (args[0] !== undefined && !isItem(args[0])) return { error: 'usage: !pickup [item] [count]' };
      const item = args[0]?.toLowerCase();
      const count = args[1] !== undefined ? parseCount(args[1], 2304) : null;
      if (args[1] !== undefined && count === null) return { error: 'count must be a positive integer' };
      return {
        type: 'pickup_items',
        ...(item !== undefined ? { item } : {}),
        ...(count !== null ? { count } : {}),
      };
    }

    default:
      return { error: `unknown command "${name}"` };
  }
}

/**
 * The single source of truth for the command surface: `name` routes the command
 * and `usage` is what `!help` prints. Adding an entry here is enough - the
 * parser set, the dispatcher and the help text all follow, so they cannot drift
 * apart and no command can exist without being documented.
 */
export const COMMAND_SYNTAX: readonly { name: string; usage: string }[] = [
  { name: 'come', usage: 'come' },
  { name: 'goto', usage: 'goto <x> <y> <z>' },
  { name: 'follow', usage: 'follow <player>' },
  { name: 'guard', usage: 'guard <player>' },
  { name: 'stop', usage: 'stop' },
  { name: 'stay', usage: 'stay' },
  { name: 'pickup', usage: 'pickup [item] [count]' },
  { name: 'mine', usage: 'mine <block> [count]' },
  { name: 'deposit', usage: 'deposit [item]' },
  { name: 'withdraw', usage: 'withdraw [item] [count]' },
  { name: 'equip', usage: 'equip <item>' },
  { name: 'drop', usage: 'drop <item> [count]' },
  { name: 'eat', usage: 'eat [item]' },
  { name: 'inventory', usage: 'inventory' },
  { name: 'status', usage: 'status' },
  { name: 'remember', usage: 'remember <name>' },
  { name: 'home', usage: 'home' },
  { name: 'help', usage: 'help' },
];

/** Commands that never involve the AI and must respond instantly. */
export const DETERMINISTIC_COMMANDS: ReadonlySet<string> = new Set(
  COMMAND_SYNTAX.map((command) => command.name),
);

/** Commands handled entirely inside the chat layer (no world action). */
export const LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  'stop',
  'status',
  'inventory',
  'help',
  'remember',
  'home',
]);

/** `!remember <name>` / `!home` are local; validated name here. */
export function parseLocationName(value: string | undefined): string | null {
  return parseName(value);
}