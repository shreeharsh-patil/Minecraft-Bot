/**
 * The AI action allowlist - the single source of truth for what the model can do.
 *
 * This union is intentionally closed. The model may only emit one of these
 * shapes; the validator in `src/executor/validator.ts` rejects anything else,
 * which is what makes prompt injection from Minecraft chat non-executable.
 */
import type { Vec3Like } from './world.js';

export const ACTION_TYPES = [
  'move_to_player',
  'move_to_position',
  'follow_player',
  'stop',
  'mine_block',
  'collect_resource',
  'place_block',
  'build_structure',
  'equip_item',
  'drop_item',
  'deposit_items',
  'withdraw_items',
  'eat',
  'attack_hostile',
  'defend_player',
  'look_at',
  'wait',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export interface BaseAction {
  type: ActionType;
  /** Short model-supplied explanation, surfaced to the requester in chat. */
  note?: string;
}

/** Movement -------------------------------------------------------------- */
export interface MoveToPlayerAction extends BaseAction {
  type: 'move_to_player';
  player: string;
  /** Optional max approach distance in blocks. */
  maxDistance?: number;
}

export interface MoveToPositionAction extends BaseAction {
  type: 'move_to_position';
  position: Vec3Like;
  maxDistance?: number;
}

export interface FollowPlayerAction extends BaseAction {
  type: 'follow_player';
  player: string;
  /** Stay within this distance; never walk inside the player. */
  distance?: number;
}

export interface StopAction extends BaseAction {
  type: 'stop';
}

export interface LookAtAction extends BaseAction {
  type: 'look_at';
  position: Vec3Like;
  durationMs?: number;
}

export interface WaitAction extends BaseAction {
  type: 'wait';
  durationMs: number;
}

/** Mining / collection ---------------------------------------------------- */
export interface MineBlockAction extends BaseAction {
  type: 'mine_block';
  blockName: string;
  count: number;
}

export interface CollectResourceAction extends BaseAction {
  type: 'collect_resource';
  /** Human-readable item name, e.g. "oak logs" or "cobblestone". */
  resource: string;
  count: number;
  /** Optional: only from one named location, e.g. "home". */
  from?: string;
}

/** Inventory -------------------------------------------------------------- */
export interface EquipItemAction extends BaseAction {
  type: 'equip_item';
  item: string;
}

export interface DropItemAction extends BaseAction {
  type: 'drop_item';
  item: string;
  count?: number;
  /** Drop at the requester's feet (default) or into a nearby chest. */
  where?: 'floor' | 'chest';
}

export interface DepositItemsAction extends BaseAction {
  type: 'deposit_items';
  item?: string;
  /** Chest location: a named location, "nearest", or omitted for the nearest chest. */
  location?: string;
}

export interface WithdrawItemsAction extends BaseAction {
  type: 'withdraw_items';
  item?: string;
  count?: number;
  location?: string;
}

/** Building --------------------------------------------------------------- */
export interface PlaceBlockAction extends BaseAction {
  type: 'place_block';
  blockName: string;
  position: Vec3Like;
  /** Face to place against: "top" | "side" | "front" | default auto. */
  face?: 'top' | 'side' | 'front' | 'auto';
}

export interface BuildStructureAction extends BaseAction {
  type: 'build_structure';
  structure: 'wall' | 'platform' | 'simple_house';
  position: Vec3Like;
  /** e.g. length/height/size depending on structure. */
  dimensions: Record<string, number>;
  material?: string;
}

/** Survival / combat ------------------------------------------------------ */
export interface EatAction extends BaseAction {
  type: 'eat';
  item?: string;
}

export interface AttackHostileAction extends BaseAction {
  type: 'attack_hostile';
  /** Omit to attack the nearest hostile mob. */
  target?: string;
  radius?: number;
}

export interface DefendPlayerAction extends BaseAction {
  type: 'defend_player';
  player: string;
  radius?: number;
  /** Optional duration; omit for "until stopped". */
  durationMs?: number;
}

/**
 * The union of everything executable. Note that `build_structure` is included
 * but gated behind an authorized player + safety check before execution.
 */
export type BotAction =
  | MoveToPlayerAction
  | MoveToPositionAction
  | FollowPlayerAction
  | StopAction
  | LookAtAction
  | WaitAction
  | MineBlockAction
  | CollectResourceAction
  | EquipItemAction
  | DropItemAction
  | DepositItemsAction
  | WithdrawItemsAction
  | PlaceBlockAction
  | BuildStructureAction
  | EatAction
  | AttackHostileAction
  | DefendPlayerAction;

export function isActionType(value: unknown): value is ActionType {
  return typeof value === 'string' && (ACTION_TYPES as readonly string[]).includes(value);
}