/** Equip (hold) an item from the bot's inventory. */
import type { MinecraftFacade } from '../../types/facade.js';
import type { ItemParams, Skill, SkillResult } from '../../types/skill.js';
import type { ActionType } from '../../types/actions.js';
import { CONFLICT_GROUP } from '../../types/task.js';
import type { ExecutionContext } from '../../types/task.js';
import { describeError, failedResult, guardedOp, isCancellation, normaliseBlockName } from '../internal/helpers.js';

export class EquipItemSkill implements Skill<ItemParams> {
  public readonly name: ActionType = 'equip_item';
  public readonly conflictGroups: readonly string[] = [CONFLICT_GROUP.INVENTORY];

  constructor(private readonly facade: MinecraftFacade) {}

  public async execute(params: ItemParams, ctx: ExecutionContext): Promise<SkillResult> {
    const item = normaliseBlockName(params.item ?? '');
    if (item.length === 0) {
      return failedResult('I need to know what to equip.', 0);
    }

    const available = this.facade.countItem(item);
    if (available <= 0) {
      return failedResult(`I don't have any ${item.replace(/_/g, ' ')}.`, 0);
    }
    if (this.facade.heldItem() === item) {
      return { ok: true, detail: `I'm already holding ${item.replace(/_/g, ' ')}.`, count: available };
    }

    try {
      const result = await guardedOp(() => this.facade.equipItem(item), ctx, `Equipping ${item}`);
      if (result.status === 'cancelled') {
        return { ok: false, detail: `Stopped before equipping ${item}.`, count: 0 };
      }
      if (result.status === 'error') {
        return failedResult(result.reason, 0);
      }
      if (!result.value) {
        return failedResult(`I couldn't equip ${item.replace(/_/g, ' ')}.`, 0);
      }
      return { ok: true, detail: `Equipped ${item.replace(/_/g, ' ')}.`, count: 1 };
    } catch (error) {
      if (isCancellation(error)) {
        return { ok: false, detail: `Stopped before equipping ${item}.`, count: 0 };
      }
      return failedResult(`Equipping ${item} failed: ${describeError(error)}`, 0);
    }
  }
}

export function createEquipItemSkill(facade: MinecraftFacade): EquipItemSkill {
  return new EquipItemSkill(facade);
}