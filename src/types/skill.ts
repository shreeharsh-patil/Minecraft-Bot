/** Interfaces implemented by the skill layer, consumed by the executor. */
import type { ActionType } from '../types/actions.js';
import type { BlockPos, Vec3Like } from '../types/world.js';
import type { ExecutionContext } from '../types/task.js';

export interface SkillResult {
  ok: boolean;
  detail?: string;
  /** Blocks mined / items handled, for reporting. */
  count?: number;
  /** Remaining quantity when the skill stopped early. */
  remaining?: number;
}

export interface SkillInput {
  action: unknown;
  ctx: ExecutionContext;
}

/**
 * A skill is the only way anything is done to the Minecraft world.
 * The executor maps ActionType -> Skill via a registry, so adding a new
 * capability never means editing a giant switch statement.
 */
export interface Skill<TParams = unknown> {
  /** Must equal the ActionType this skill handles. */
  readonly name: ActionType;
  /** Which bodies this skill needs exclusive access to. */
  readonly conflictGroups: readonly string[];
  execute(params: TParams, ctx: ExecutionContext): Promise<SkillResult>;
}

export type SkillRegistry = ReadonlyMap<ActionType, Skill<never>>;

/** Shared shapes used by several skills. */

export interface GotoPlayerParams {
  player: string;
  maxDistance?: number;
}

export interface GotoPositionParams {
  position: Vec3Like;
  maxDistance?: number;
}

export interface MineParams {
  blockName: string;
  count: number;
}

export interface CollectParams {
  resource: string;
  count: number;
  from?: string;
}

export interface PlaceParams {
  blockName: string;
  position: BlockPos;
  face?: 'top' | 'side' | 'front' | 'auto';
}

export interface ItemParams {
  item: string;
  count?: number;
  where?: 'floor' | 'chest';
}

export interface ChestParams {
  item?: string;
  count?: number;
  location?: string;
}

export interface EatParams {
  item?: string;
}

export interface AttackParams {
  target?: string;
  radius?: number;
}

export interface DefendParams {
  player: string;
  radius?: number;
  durationMs?: number;
}

export interface LookParams {
  position: Vec3Like;
  durationMs?: number;
}

export interface WaitParams {
  durationMs: number;
}