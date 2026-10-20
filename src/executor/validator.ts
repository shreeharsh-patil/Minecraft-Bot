/**
 * Validation of AI-generated actions. This is the security chokepoint.
 *
 * Nothing reaches a skill without passing `validateAction`. The validator is
 * deliberately strict and schema-driven rather than a permissive cast, because
 * this is the boundary between untrusted model output and real world actions.
 *
 * Human-written names ("Oak Logs", "Iron-Ingot") are canonicalised into the
 * strict Minecraft shape rather than rejected: the canonical form is checked
 * against the same strict pattern, so this can only make a legitimate request
 * expressible - it can never let a dangerous one through.
 */
import { isActionType, type ActionType, type BotAction } from '../types/actions.js';
import type { Vec3Like } from '../types/world.js';
import {
  DEFAULT_MAX_BUILD,
  DEFAULT_MAX_MINE,
  DEFAULT_MAX_WAIT_MS,
  MAX_BUILD_DIMENSION,
  MAX_DEFEND_DURATION_MS,
  MAX_DROP_COUNT,
  MAX_FOLLOW_DURATION_MS,
  MAX_PLANNED_ACTIONS,
} from '../safety/actionLimits.js';
import { detectInjectedIntent } from '../safety/chatInjectionGuard.js';
import { MAX_LOOK_MS } from '../skills/basic/lookAt.js';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  /** Set when valid; the typed action. */
  action?: BotAction;
}

/**
 * Preserves the literal action type so the discriminated union still narrows.
 * A plain `{ type, ...note }` object widens `type` to the full union and every
 * downstream assignment stops type-checking.
 */
function base<T extends ActionType>(type: T, note: string | undefined): { type: T; note?: string } {
  return note === undefined ? { type } : { type, note };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isVec3(value: unknown): value is Vec3Like {
  return (
    isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)
  );
}

/**
 * The world border.
 *
 * The executor refuses a position outside it, so the validator refuses the
 * same coordinates: a plan that validates must be a plan that can run.
 */
const WORLD_BORDER_XZ = 30_000_000;
const WORLD_BORDER_Y = 20_000_000;

function isInsideWorld(position: Vec3Like): boolean {
  return (
    Math.abs(position.x) <= WORLD_BORDER_XZ &&
    Math.abs(position.y) <= WORLD_BORDER_Y &&
    Math.abs(position.z) <= WORLD_BORDER_XZ
  );
}

/** Player/entity names: bounded length, no control characters. */
const NAME_PATTERN = /^[A-Za-z0-9_]{1,32}$/;

function isPlayerName(value: unknown): value is string {
  return typeof value === 'string' && NAME_PATTERN.test(value);
}

/**
 * Block/item names as Minecraft reports them: lowercase, underscores, digits.
 * This blocks path traversal, code injection and command injection through a
 * "block name".
 */
const ITEM_NAME_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * The shape a *human* may write an item name in: "Oak Logs", "Iron-Ingot".
 * Anything else - a slash, a semicolon, a path fragment - is rejected
 * outright rather than cleaned up.
 */
const RAW_ITEM_NAME_PATTERN = /^[A-Za-z0-9 _-]{1,64}$/;

/**
 * Turns a human-written item name into the canonical Minecraft form:
 * "Oak Logs" -> "oak_logs", "Iron-Ingot" -> "iron_ingot".
 *
 * The result is re-checked against `ITEM_NAME_PATTERN`, so only the strict
 * shape ever reaches a skill: the normalisation can never widen what the
 * validator accepts, it only makes the legitimate shapes expressible.
 */
function normaliseItemName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!RAW_ITEM_NAME_PATTERN.test(value)) return undefined;
  const normalised = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ITEM_NAME_PATTERN.test(normalised) ? normalised : undefined;
}

/**
 * Named locations ("home", "the mine"): letters, digits, spaces and dashes.
 * A location is only ever used to look something up, never to build a path.
 */
const LOCATION_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;

function normaliseLocation(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!LOCATION_PATTERN.test(value)) return undefined;
  const normalised = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return normalised.length > 0 ? normalised : undefined;
}

/**
 * Dimension keys become properties of a plain object, so they have to be
 * plain identifiers: `__proto__` would be swallowed by the prototype setter
 * and the requested size would silently vanish.
 */
const DIMENSION_KEY_PATTERN = /^[a-z][a-z_]{0,15}$/;

/** Keys that must never become a property of a plain object. */
const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Optional bounded note text. Control characters are stripped by key, not by regex. */
function sanitizeNote(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, 200);
}

/**
 * Bounded chat text for `say` actions. Freer than an item name (sentences need
 * spaces) but still bounded and injection-screened, so a chat message can never
 * smuggle a command through what the bot "says".
 */
const SAY_MAX_CHARS = 200;

function sanitizeChatText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (trimmed.length === 0 || trimmed.length > SAY_MAX_CHARS) return undefined;
  // A leading slash is a SERVER COMMAND, not chat: "/op @a" or "/login <pw>"
  // would be executed by the server the moment the bot sends it.
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return undefined;
  if (detectInjectedIntent(trimmed)) return undefined;
  return trimmed;
}

function positiveInt(value: unknown, max: number): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  if (value <= 0) return undefined;
  return Math.min(Math.floor(value), max);
}

/**
 * A positive integer that must not exceed `max`.
 *
 * Unlike `positiveInt` this REJECTS an oversized value instead of clamping
 * it: when the ceiling is a safety limit, quietly shrinking the request
 * would hide the fact that too much was asked for - and would make the
 * validator accept something the executor later refuses.
 */
function boundedPositiveInt(value: unknown, max: number): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  if (value <= 0 || value > max) return undefined;
  return Math.floor(value);
}

/** Like `boundedPositiveInt`, but zero is allowed (a no-op wait). */
function boundedNonNegativeInt(value: unknown, max: number): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  if (value < 0 || value > max) return undefined;
  return Math.floor(value);
}

/**
 * An optional distance (or duration), clamped into [0, max].
 *
 * `undefined` - the field was not requested at all.
 * `null` - the field WAS requested but is not a usable number. The caller
 *   must then refuse the action: silently dropping it would turn "stay 5
 *   blocks away" into "no limit at all" and a negative distance into "walk
 *   right up to them". This is the same rule the durations above follow.
 */
function optionalDistance(value: unknown, max = 64): number | null | undefined {
  if (value === undefined) return undefined;
  if (!isFiniteNumber(value) || value < 0) return null;
  return Math.min(value, max);
}

export type { BotAction };
/**
 * Validates one raw action object.
 *
 * Rules:
 *  - `type` must be on the allowlist;
 *  - required fields must have the right primitive type;
 *  - unknown extra keys are stripped (no smuggling parameters through);
 *  - string fields are pattern-checked, never interpolated.
 */
export function validateAction(raw: unknown): ValidationResult {
  if (!isRecord(raw)) return { valid: false, reason: 'action must be an object' };

  const type = raw['type'];
  if (!isActionType(type)) {
    return { valid: false, reason: `action type "${String(type)}" is not in the allowlist` };
  }

  // A note is documentation, not an instruction. One that carries an
  // injection marker is dropped rather than carried into the action: it must
  // never be surfaced, not even later, by something that trusts it.
  const rawNote = sanitizeNote(raw['note']);
  const note =
    rawNote !== undefined && detectInjectedIntent(rawNote) !== null ? undefined : rawNote;

  switch (type) {
    case 'move_to_player':
    case 'follow_player':
    case 'defend_player': {
      const player = raw['player'];
      if (!isPlayerName(player)) {
        return { valid: false, reason: `${type} requires a valid "player" name` };
      }
      const maxDistance = optionalDistance(raw['maxDistance'] ?? raw['distance'] ?? raw['radius']);
      if (maxDistance === null) {
        return { valid: false, reason: `${type} distance must be a non-negative number of blocks` };
      }
      if (type === 'move_to_player') {
        return {
          valid: true,
          action: {
            ...base(type, note),
            player,
            ...(maxDistance !== undefined ? { maxDistance } : {}),
          },
        };
      }
      if (type === 'follow_player') {
        const durationMs = raw['durationMs'] === undefined
          ? undefined
          : boundedPositiveInt(raw['durationMs'], MAX_FOLLOW_DURATION_MS);
        if (raw['durationMs'] !== undefined && durationMs === undefined) {
          return { valid: false, reason: 'follow_player duration must be a positive number of milliseconds' };
        }
        return {
          valid: true,
          action: {
            ...base(type, note),
            player,
            ...(maxDistance !== undefined ? { distance: maxDistance } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
          },
        };
      }
      const durationMs = raw['durationMs'] === undefined
        ? undefined
        : boundedPositiveInt(raw['durationMs'], MAX_DEFEND_DURATION_MS);
      if (raw['durationMs'] !== undefined && durationMs === undefined) {
        return { valid: false, reason: 'defend_player duration must be a positive number of milliseconds' };
      }
      return {
        valid: true,
        action: {
          ...base(type, note),
          player,
          ...(maxDistance !== undefined ? { radius: maxDistance } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      };
    }

    case 'move_to_position':
    case 'place_block': {
      const position = raw['position'];
      if (!isVec3(position)) {
        return { valid: false, reason: `${type} requires a numeric "position"` };
      }
      if (!isInsideWorld(position)) {
        return { valid: false, reason: 'position is outside the world border' };
      }
      if (type === 'move_to_position') {
        const maxDistance = optionalDistance(raw['maxDistance']);
        if (maxDistance === null) {
          return { valid: false, reason: 'move_to_position "maxDistance" must be a non-negative number of blocks' };
        }
        return {
          valid: true,
          action: { ...base(type, note), position, ...(maxDistance !== undefined ? { maxDistance } : {}) },
        };
      }
      const blockName = normaliseItemName(raw['blockName']);
      if (blockName === undefined) {
        return { valid: false, reason: 'place_block requires a valid "blockName"' };
      }
      const faceRaw = raw['face'];
      const face =
        faceRaw === 'top' || faceRaw === 'side' || faceRaw === 'front' || faceRaw === 'auto'
          ? faceRaw
          : 'auto';
      return { valid: true, action: { ...base(type, note), position, blockName, face } };
    }

    case 'mine_block': {
      const blockName = normaliseItemName(raw['blockName']);
      if (blockName === undefined) {
        return { valid: false, reason: 'mine_block requires a valid "blockName"' };
      }
      const count = positiveInt(raw['count'], DEFAULT_MAX_MINE);
      if (count === undefined) {
        return { valid: false, reason: 'mine_block requires a positive "count"' };
      }
      return { valid: true, action: { ...base(type, note), blockName, count } };
    }

    case 'collect_resource': {
      const resource = normaliseItemName(raw['resource']);
      if (resource === undefined) {
        return { valid: false, reason: 'collect_resource requires a valid "resource" name' };
      }
      const count = positiveInt(raw['count'], DEFAULT_MAX_MINE);
      if (count === undefined) {
        return { valid: false, reason: 'collect_resource requires a positive "count"' };
      }
      const from = raw['from'] === undefined ? undefined : normaliseLocation(raw['from']);
      if (raw['from'] !== undefined && from === undefined) {
        return { valid: false, reason: 'invalid "from" location' };
      }
      return {
        valid: true,
        action: {
          ...base(type, note),
          resource,
          count,
          ...(from !== undefined ? { from } : {}),
        },
      };
    }
case 'deposit_items':
    case 'withdraw_items': {
      const item = raw['item'] === undefined ? undefined : normaliseItemName(raw['item']);
      if (raw['item'] !== undefined && item === undefined) {
        return { valid: false, reason: `${type} "item" must be a valid item name` };
      }
      const location = raw['location'] === undefined ? undefined : normaliseLocation(raw['location']);
      if (raw['location'] !== undefined && location === undefined) {
        return { valid: false, reason: 'invalid chest location' };
      }
      const count = raw['count'] === undefined ? undefined : positiveInt(raw['count'], 2304);
      if (raw['count'] !== undefined && count === undefined) {
        return { valid: false, reason: `${type} "count" must be a positive integer` };
      }
      if (type === 'withdraw_items') {
        return {
          valid: true,
          action: {
            ...base(type, note),
            ...(item !== undefined ? { item } : {}),
            ...(count !== undefined ? { count } : {}),
            ...(location !== undefined ? { location } : {}),
          },
        };
      }
      return {
        valid: true,
        action: {
          ...base(type, note),
          ...(item !== undefined ? { item } : {}),
          ...(count !== undefined ? { count } : {}),
          ...(location !== undefined ? { location } : {}),
        },
      };
    }

    case 'attack_hostile': {
      const target = raw['target'];
      if (target !== undefined && !isPlayerName(target)) {
        return { valid: false, reason: 'attack_hostile "target" must be a valid name' };
      }
      const radius = optionalDistance(raw['radius'], 32);
      if (radius === null) {
        return { valid: false, reason: 'attack_hostile "radius" must be a non-negative number of blocks' };
      }
      return {
        valid: true,
        action: {
          ...base(type, note),
          ...(target !== undefined ? { target: target } : {}),
          ...(radius !== undefined ? { radius } : {}),
        },
      };
    }

    case 'build_structure': {
      const structure = raw['structure'];
      if (structure !== 'wall' && structure !== 'platform' && structure !== 'simple_house') {
        return { valid: false, reason: 'unsupported structure type' };
      }
      const position = raw['position'];
      if (!isVec3(position)) {
        return { valid: false, reason: 'build_structure requires a "position"' };
      }
      if (!isInsideWorld(position)) {
        return { valid: false, reason: 'position is outside the world border' };
      }
      const dims = raw['dimensions'];
      if (!isRecord(dims)) return { valid: false, reason: 'build_structure requires "dimensions"' };
      const clean: Record<string, number> = {};
      // The executor prices a structure by the PRODUCT of its sides, so the
      // validator prices it the same way: a plan that validates must be a
      // plan the executor will not refuse for being too big.
      let volume = 1;
      for (const [k, v] of Object.entries(dims)) {
        if (!DIMENSION_KEY_PATTERN.test(k) || UNSAFE_OBJECT_KEYS.has(k)) {
          return { valid: false, reason: `invalid dimension key "${k}"` };
        }
        if (!isFiniteNumber(v) || v <= 0) {
          return { valid: false, reason: 'dimensions must be positive numbers' };
        }
        const side = Math.min(Math.floor(v), MAX_BUILD_DIMENSION);
        clean[k] = side;
        volume *= side;
      }
      if (volume > DEFAULT_MAX_BUILD) {
        return {
          valid: false,
          reason: `structure volume ${volume} exceeds the build limit ${DEFAULT_MAX_BUILD}`,
        };
      }
      const material = raw['material'] === undefined ? undefined : normaliseItemName(raw['material']);
      if (raw['material'] !== undefined && material === undefined) {
        return { valid: false, reason: 'invalid material name' };
      }
      return {
        valid: true,
        action: {
          ...base(type, note),
          structure,
          position,
          dimensions: clean,
          ...(material !== undefined ? { material } : {}),
        },
      };
    }

    case 'equip_item': {
      const item = normaliseItemName(raw['item']);
      if (item === undefined) return { valid: false, reason: 'equip_item requires a valid "item"' };
      return { valid: true, action: { ...base(type, note), item } };
    }

    case 'drop_item': {
      const item = normaliseItemName(raw['item']);
      if (item === undefined) return { valid: false, reason: 'drop_item requires a valid "item"' };
      // The executor refuses more than `MAX_DROP_COUNT`, so the validator
      // refuses it too: a plan that validates must be a plan that can run.
      const count = raw['count'] === undefined ? undefined : boundedPositiveInt(raw['count'], MAX_DROP_COUNT);
      if (raw['count'] !== undefined && count === undefined) {
        return { valid: false, reason: `drop count must be between 1 and ${MAX_DROP_COUNT}` };
      }
      const where = raw['where'] === 'chest' ? 'chest' : 'floor';
      return {
        valid: true,
        action: { ...base(type, note), item, ...(count !== undefined ? { count } : {}), where },
      };
    }

    case 'pickup_items': {
      const item = raw['item'] === undefined ? undefined : normaliseItemName(raw['item']);
      if (raw['item'] !== undefined && item === undefined) {
        return { valid: false, reason: 'pickup_items "item" must be a valid item name' };
      }
      const count = raw['count'] === undefined ? undefined : positiveInt(raw['count'], 2304);
      if (raw['count'] !== undefined && count === undefined) {
        return { valid: false, reason: 'pickup_items "count" must be a positive integer' };
      }
      const radius = optionalDistance(raw['radius'], 32);
      if (radius === null) {
        return { valid: false, reason: 'pickup_items "radius" must be a non-negative number of blocks' };
      }
      return {
        valid: true,
        action: {
          ...base(type, note),
          ...(item !== undefined ? { item } : {}),
          ...(count !== undefined ? { count } : {}),
          ...(radius !== undefined ? { radius } : {}),
        },
      };
    }

    case 'eat': {
      const item = raw['item'] === undefined ? undefined : normaliseItemName(raw['item']);
      if (raw['item'] !== undefined && item === undefined) {
        return { valid: false, reason: 'eat requires a valid "item"' };
      }
      return {
        valid: true,
        action: { ...base(type, note), ...(item !== undefined ? { item } : {}) },
      };
    }

    case 'look_at': {
      const position = raw['position'];
      if (!isVec3(position)) return { valid: false, reason: 'look_at requires a numeric "position"' };
      const durationMs = optionalDistance(raw['durationMs'], MAX_LOOK_MS);
      if (durationMs === null) {
        return { valid: false, reason: 'look_at "durationMs" must be a non-negative number of milliseconds' };
      }
      return {
        valid: true,
        action: { ...base(type, note), position, ...(durationMs !== undefined ? { durationMs } : {}) },
      };
    }

    case 'wait': {
      // The executor refuses a wait longer than `DEFAULT_MAX_WAIT_MS`, so the
      // validator refuses it here instead of letting it fail later.
      const durationMs = boundedNonNegativeInt(raw['durationMs'], DEFAULT_MAX_WAIT_MS);
      if (durationMs === undefined) {
        return { valid: false, reason: `wait duration must be between 0 and ${DEFAULT_MAX_WAIT_MS} ms` };
      }
      return { valid: true, action: { ...base(type, note), durationMs } };
    }

    case 'stop':
      return { valid: true, action: { ...base(type, note) } };

    case 'say': {
      const message = sanitizeChatText(raw['message']);
      if (message === undefined) {
        return { valid: false, reason: 'say requires a bounded "message"' };
      }
      return { valid: true, action: { type, message, ...(note !== undefined ? { note } : {}) } };
    }

    default:
      // Unreachable while ActionType and this switch are kept in sync.
      return { valid: false, reason: `unhandled action type "${String(type)}"` };
  }
}

export interface PlanValidationResult {
  actions: BotAction[];
  rejected: Array<{ raw: unknown; reason: string }>;
}

/**
 * Validates a whole plan. Invalid actions are dropped rather than throwing,
 * so one hallucinated step does not discard an otherwise good plan - but they
 * are reported so the caller can log and surface them.
 */
export function validatePlan(raw: unknown): PlanValidationResult {
  if (!Array.isArray(raw)) {
    return { actions: [], rejected: [{ raw, reason: 'plan must be an array' }] };
  }
  if (raw.length > MAX_PLANNED_ACTIONS) {
    return {
      actions: [],
      rejected: [
        { raw: raw.length, reason: `plan has ${raw.length} actions, limit is ${MAX_PLANNED_ACTIONS}` },
      ],
    };
  }

  const actions: BotAction[] = [];
  const rejected: Array<{ raw: unknown; reason: string }> = [];

  for (const candidate of raw) {
    // Defence in depth: reject obviously injected content before schema checks.
    if (isRecord(candidate) && typeof candidate['note'] === 'string') {
      const injected = detectInjectedIntent(candidate['note']);
      if (injected) {
        rejected.push({ raw: candidate, reason: injected });
        continue;
      }
    }
    const result = validateAction(candidate);
    if (result.valid && result.action) actions.push(result.action);
    else rejected.push({ raw: candidate, reason: result.reason ?? 'invalid action' });
  }

  return { actions, rejected };
}