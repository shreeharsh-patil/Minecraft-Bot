/** Place a single block at an explicit position. */
import type { MinecraftFacade } from '../../types/facade.js';
import type { PlaceParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import type { BlockPos } from '../../types/world.js';
import {
  approachBlock,
  describeError,
  failedResult,
  floorPos,
  guardedOp,
  isCancellation,
  normaliseBlockName,
  formatPos,
} from '../internal/helpers.js';

/** Blocks the bot will happily replace when asked to build there. */
const REPLACEABLE: ReadonlySet<string> = new Set(['air', 'water', 'grass', 'short_grass', 'tall_grass', 'snow', 'fire', 'torch']);

export class PlaceBlockSkill implements Skill<PlaceParams> {
  public readonly name: ActionType = 'place_block';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.BUILDING];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: PlaceParams, ctx: ExecutionContext): Promise<SkillResult> {
    const blockName = normaliseBlockName(params.blockName ?? '');
    if (blockName.length === 0) {
      return failedResult('I need to know which block to place.', 0);
    }
    const position = params.position;
    if (
      typeof position !== 'object' ||
      position === null ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) {
      return failedResult('That is not a valid place to build.', 0);
    }
    const target: BlockPos = floorPos(position);

    if (this.facade.countItem(blockName) <= 0) {
      return failedResult(`I don't have any ${blockName.replace(/_/g, ' ')}.`, 0);
    }

    const existing = this.facade.getBlockAt(target);
    if (existing === blockName) {
      return { ok: true, detail: `There is already a ${blockName} there.`, count: 0 };
    }
    if (existing !== null && !REPLACEABLE.has(existing)) {
      return failedResult(`There is already a ${existing} at ${formatPos(target)}.`, 0);
    }

    try {
      const arrival = await approachBlock(this.facade, ctx, target, 'Getting into place');
      if (arrival.status === 'cancelled') {
        return { ok: false, detail: 'Stopped before placing the block.', count: 0 };
      }
      if (arrival.status !== 'arrived') {
        return failedResult(`I can't reach ${formatPos(target)} to build there.`, 0);
      }

      const held = this.facade.heldItem();
      if (held !== blockName) {
        const equipped = await guardedOp(() => this.facade.equipItem(blockName), ctx, `Equipping ${blockName}`);
        if (equipped.status === 'cancelled') {
          return { ok: false, detail: 'Stopped before placing the block.', count: 0 };
        }
        if (equipped.status === 'error' || !equipped.value) {
          return failedResult(`I couldn't hold the ${blockName}.`, 0);
        }
      }

      const placed = await guardedOp(
        () => this.facade.placeBlock(target, blockName, params.face ?? 'auto'),
        ctx,
        `Placing ${blockName}`,
      );
      if (placed.status === 'cancelled') {
        return { ok: false, detail: 'Stopped while placing the block.', count: 0 };
      }
      if (placed.status === 'error') {
        return failedResult(placed.reason, 0);
      }
      if (!placed.value) {
        return failedResult(`I couldn't place the ${blockName} at ${formatPos(target)}.`, 0);
      }

      return { ok: true, detail: `Placed ${blockName} at ${formatPos(target)}.`, count: 1 };
    } catch (error) {
      if (isCancellation(error)) {
        return { ok: false, detail: 'Stopped while placing the block.', count: 0 };
      }
      return failedResult(`Placing ${blockName} failed: ${describeError(error)}`, 0);
    }
  }
}

export function createPlaceBlockSkill(facade: MinecraftFacade): PlaceBlockSkill {
  return new PlaceBlockSkill(facade);
}