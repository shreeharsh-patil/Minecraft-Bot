/**
 * Drop items on the floor, or hand them to a nearby chest.
 * The chest path delegates to the shared chest helpers so there is one
 * implementation of "find chest, walk over, transfer".
 */
import type { MinecraftFacade } from '../../types/facade.js';
import type { ItemParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import {
  cancelledResult,
  describeError,
  failedResult,
  guardedOp,
  isCancellation,
  normaliseBlockName,
} from '../internal/helpers.js';
import { transferIntoChest } from './chestManager.js';

export class DropItemSkill implements Skill<ItemParams> {
  public readonly name: ActionType = 'drop_item';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.INVENTORY];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: ItemParams, ctx: ExecutionContext): Promise<SkillResult> {
    const item = normaliseBlockName(params.item ?? '');
    if (item.length === 0) {
      return failedResult('I need to know what to drop.', 0);
    }

    const available = this.facade.countItem(item);
    if (available <= 0) {
      return failedResult(`I don't have any ${item.replace(/_/g, ' ')}.`, 0);
    }

    // Unbounded requests are clamped to what is actually carried.
    const requested = Math.floor(params.count ?? available);
    if (!Number.isFinite(requested) || requested <= 0) {
      return failedResult('I need a count of at least 1.', 0);
    }
    const count = Math.min(requested, available);
    const pretty = item.replace(/_/g, ' ');

    try {
      if (params.where === 'chest') {
        const result = await transferIntoChest(this.facade, ctx, { item, count });
        // The helper knows exactly how much moved and how much is left: a
        // chest that fills up half way through must not be passed off as a
        // complete drop.
        if (!result.ok) return failedResult(result.detail, result.count, count);
        const detail =
          result.count < count
            ? `Put ${result.count} of ${count} ${pretty} in the chest.`
            : `Put ${result.count} ${pretty} in the chest.`;
        return {
          ok: true,
          detail,
          count: result.count,
          ...(result.count < count ? { remaining: count - result.count } : {}),
        };
      }

      const dropped = await guardedOp(() => this.facade.dropItem(item, count), ctx, `Dropping ${count} ${item}`);
      if (dropped.status === 'cancelled') {
        return cancelledResult(`Stopped before dropping ${pretty}.`, 0, count);
      }
      if (dropped.status === 'error') {
        return failedResult(dropped.reason, 0, count);
      }
      if (dropped.value <= 0) {
        return failedResult(`I couldn't drop any ${pretty}.`, 0, count);
      }
      const detail =
        dropped.value < count
          ? `Dropped ${dropped.value} of ${count} ${pretty}.`
          : `Dropped ${dropped.value} ${pretty}.`;
      return {
        ok: dropped.value > 0,
        detail,
        count: dropped.value,
        ...(dropped.value < count ? { remaining: count - dropped.value } : {}),
      };
    } catch (error) {
      if (isCancellation(error)) {
        return cancelledResult(`Stopped before dropping ${pretty}.`, 0, count);
      }
      return failedResult(`Dropping ${pretty} failed: ${describeError(error)}`, 0, count);
    }
  }
}

export function createDropItemSkill(facade: MinecraftFacade): DropItemSkill {
  return new DropItemSkill(facade);
}