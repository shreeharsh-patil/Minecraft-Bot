/**
 * Validation of AI-generated actions. This is the security chokepoint.
 *
 * Nothing reaches a skill without passing `validateAction`. The validator is
 * deliberately strict and schema-driven rather than a permissive cast, because
 * this is the boundary between untrusted model output and real world actions.
 */
import { isActionType, type ActionType, type BotAction } from '../types/actions.js';
import type { Vec3Like } from '../types/world.js';
import { MAX_PLANNED_ACTIONS } from '../safety/actionLimits.js';
import { detectInjectedIntent } from '../safety/chatInjectionGuard.js';

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

function isItemName(value: unknown): value is string {
  return typeof value === 'string' && ITEM_NAME_PATTERN.test(value);
}

/** Optional bounded note text. Control characters are stripped by key, not by regex. */
function sanitizeNote(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, 200);
}

function positiveInt(value: unknown, max: number): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  if (value <= 0) return undefined;
  return Math.min(Math.floor(value), max);
}

function optionalDistance(value: unknown, max = 64): number | undefined {
  if (value === undefined) return undefined;
  if (!isFiniteNumber(value) || value < 0) return undefined;
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

  const note = sanitizeNote(raw['note']);

  switch (type) {
    case 'move_to_player':
    case 'follow_player':
    case 'defend_player': {
      const player = raw['player'];
      if (!isPlayerName(player)) {
        return { valid: false, reason: `${type} requires a valid "player" name` };
      }
      const maxDistance = optionalDistance(raw['maxDistance'] ?? raw['distance'] ?? raw['radius']);
      const durationMs = optionalDistance(raw['durationMs'], 600_000);
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
        return {
          valid: true,
          action: {
            ...base(type, note),
            player,
            ...(maxDistance !== undefined ? { distance: maxDistance } : {}),
          },
        };
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
      if (Math.abs(position.x) > 30_000_000 || Math.abs(position.z) > 30_000_000) {
        return { valid: false, reason: 'position is outside the world border' };
      }
      if (type === 'move_to_position') {
        const maxDistance = optionalDistance(raw['maxDistance']);
        return {
          valid: true,
          action: { ...base, type, position, ...(maxDistance !== undefined ? { maxDistance } : {}) },
        };
      }
      const blockName = raw['blockName'];
      if (!isItemName(blockName)) {
        return { valid: false, reason: 'place_block requires a valid "blockName"' };
      }
      const faceRaw = raw['face'];
      const face =
        faceRaw === 'top' || faceRaw === 'side' || faceRaw === 'front' || faceRaw === 'auto'
          ? faceRaw
          : 'auto';
      return { valid: true, action: { ...base, type, position, blockName, face } };
    }

    case 'mine_block': {
      const blockName = raw['blockName'];
      if (!isItemName(blockName)) {
        return { valid: false, reason: 'mine_block requires a valid "blockName"' };
      }
      const count = positiveInt(raw['count'], 10_000);
      if (count === undefined) {
        return { valid: false, reason: 'mine_block requires a positive "count"' };
      }
      return { valid: true, action: { ...base, type, blockName, count } };
    }

    case 'collect_resource': {
      const resource = raw['resource'];
      if (!isItemName(resource)) {
        return { valid: false, reason: 'collect_resource requires a valid "resource" name' };
      }
      const count = positiveInt(raw['count'], 10_000);
      if (count === undefined) {
        return { valid: false, reason: 'collect_resource requires a positive "count"' };
      }
      const from = raw['from'];
      if (from !== undefined && (typeof from !== 'string' || from.length > 32)) {
        return { valid: false, reason: 'invalid "from" location' };
      }
      return {
        valid: true,
        action: {
          ...base(type, note),
          resource,
          count,
          ...(from !== undefined ? { from: from } : {}),
        },
      };
    }
case 'deposit_items':
    case 'withdraw_items': {
      const item = raw['item'];
      if (item !== undefined && !isItemName(item)) {
        return { valid: false, reason: `${type} "item" must be a valid item name` };
      }
      const location = raw['location'];
      if (location !== undefined && (typeof location !== 'string' || location.length > 32)) {
        return { valid: false, reason: 'invalid chest location' };
      }
      const count = raw['count'] === undefined ? undefined : positiveInt(raw['count'], 2304);
      if (type === 'withdraw_items') {
        return {
          valid: true,
          action: {
            ...base(type, note),
            ...(item !== undefined ? { item: item } : {}),
            ...(count !== undefined ? { count } : {}),
            ...(location !== undefined ? { location: location } : {}),
          },
        };
      }
      return {
        valid: true,
        action: {
          ...base(type, note),
          ...(item !== undefined ? { item: item } : {}),
          ...(location !== undefined ? { location: location } : {}),
        },
      };
    }

    case 'attack_hostile': {
      const target = raw['target'];
      if (target !== undefined && !isPlayerName(target)) {
        return { valid: false, reason: 'attack_hostile "target" must be a valid name' };
      }
      const radius = optionalDistance(raw['radius'], 32);
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
      const dims = raw['dimensions'];
      if (!isRecord(dims)) return { valid: false, reason: 'build_structure requires "dimensions"' };
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(dims)) {
        if (!/^[a-z_]{1,16}$/.test(k)) return { valid: false, reason: `invalid dimension key "${k}"` };
        if (!isFiniteNumber(v) || v <= 0) {
          return { valid: false, reason: 'dimensions must be positive numbers' };
        }
        clean[k] = Math.min(Math.floor(v), 32);
      }
      const material = raw['material'];
      if (material !== undefined && !isItemName(material)) {
        return { valid: false, reason: 'invalid material name' };
      }
      return {
        valid: true,
        action: {
          ...base(type, note),
          structure,
          position,
          dimensions: clean,
          ...(material !== undefined ? { material: material } : {}),
        },
      };
    }

    case 'equip_item': {
      const item = raw['item'];
      if (!isItemName(item)) return { valid: false, reason: 'equip_item requires a valid "item"' };
      return { valid: true, action: { ...base, type, item } };
    }

    case 'drop_item': {
      const item = raw['item'];
      if (!isItemName(item)) return { valid: false, reason: 'drop_item requires a valid "item"' };
      const count = raw['count'] === undefined ? undefined : positiveInt(raw['count'], 2304);
      if (raw['count'] !== undefined && count === undefined) {
        return { valid: false, reason: 'invalid drop count' };
      }
      const where = raw['where'] === 'chest' ? 'chest' : 'floor';
      return {
        valid: true,
        action: { ...base, type, item, ...(count !== undefined ? { count } : {}), where },
      };
    }

    case 'pickup_items': {
      const item = raw['item'];
      if (item !== undefined && !isItemName(item)) {
        return { valid: false, reason: 'pickup_items "item" must be a valid item name' };
      }
      const count = raw['count'] === undefined ? undefined : positiveInt(raw['count'], 2304);
      if (raw['count'] !== undefined && count === undefined) {
        return { valid: false, reason: 'pickup_items "count" must be a positive integer' };
      }
      const radius = optionalDistance(raw['radius'], 32);
      return {
        valid: true,
        action: {
          ...base,
          type,
          ...(item !== undefined ? { item } : {}),
          ...(count !== undefined ? { count } : {}),
          ...(radius !== undefined ? { radius } : {}),
        },
      };
    }

    case 'eat': {
      const item = raw['item'];
      if (item !== undefined && !isItemName(item)) {
        return { valid: false, reason: 'eat requires a valid "item"' };
      }
      return {
        valid: true,
        action: { ...base, type, ...(item !== undefined ? { item: item } : {}) },
      };
    }

    case 'look_at': {
      const position = raw['position'];
      if (!isVec3(position)) return { valid: false, reason: 'look_at requires a numeric "position"' };
      const durationMs = optionalDistance(raw['durationMs'], 60_000);
      return {
        valid: true,
        action: { ...base, type, position, ...(durationMs !== undefined ? { durationMs } : {}) },
      };
    }

    case 'wait': {
      const durationMs = positiveInt(raw['durationMs'], 60_000);
      if (durationMs === undefined) return { valid: false, reason: 'wait requires a positive "durationMs"' };
      return { valid: true, action: { ...base, type, durationMs } };
    }

    case 'stop':
      return { valid: true, action: { ...base, type } };

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