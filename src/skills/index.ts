/**
 * Skill registry: ActionType -> Skill instance.
 *
 * The executor looks a skill up here instead of switching over action types, so
 * adding a capability never means editing a giant switch. Every value in
 * `ACTION_TYPES` must resolve - `createSkillRegistry` throws at construction
 * time if one is missing, which fails fast in tests rather than at 3am in game.
 *
 * Two notes on the frozen facade contract:
 *  - `EntitySummary` has no entity id, so the combat skills read an optional
 *    numeric `id` when present and otherwise swing (look + use);
 *  - there is no named-location lookup, so `deposit/withdraw` with a `location`
 *    falls back to the nearest chest and says so.
 */
import type { ActionType } from '../types/actions.js';
import { ACTION_TYPES } from '../types/actions.js';
import type { MinecraftFacade } from '../types/facade.js';
import type { Skill, SkillRegistry } from '../types/skill.js';

import { createLookAtSkill } from './basic/lookAt.js';
import { createSaySkill } from './basic/say.js';
import { createStopSkill } from './basic/stop.js';
import { createWaitSkill } from './basic/wait.js';
import { createBuildStructureSkill } from './building/buildStructure.js';
import { createPlaceBlockSkill } from './building/placeBlock.js';
import { createAttackHostileSkill } from './combat/attackHostile.js';
import { createDepositItemsSkill, createWithdrawItemsSkill } from './inventory/chestManager.js';
import { createDropItemSkill } from './inventory/dropItem.js';
import { createEquipItemSkill } from './inventory/equipItem.js';
import { createCollectResourceSkill } from './mining/collectResource.js';
import { createMineBlockSkill } from './mining/mineBlock.js';
import { createPickupItemsSkill } from './inventory/pickupItems.js';
import { createFollowPlayerSkill } from './movement/followPlayer.js';
import { createGotoPlayerSkill } from './movement/gotoPlayer.js';
import { createGotoPositionSkill } from './movement/gotoPosition.js';
import { createAutoEatSkill } from './survival/autoEat.js';
import { createDefendSkill } from './survival/defend.js';

/** Builds the full registry for a facade. Fails fast on a missing skill. */
export function createSkillRegistry(facade: MinecraftFacade): SkillRegistry {
  const skills: Array<Skill<never>> = [
    createGotoPlayerSkill(facade),
    createGotoPositionSkill(facade),
    createFollowPlayerSkill(facade),
    createStopSkill(facade),
    createMineBlockSkill(facade),
    createCollectResourceSkill(facade),
    createPlaceBlockSkill(facade),
    createBuildStructureSkill(facade),
    createEquipItemSkill(facade),
    createDropItemSkill(facade),
    createDepositItemsSkill(facade),
    createWithdrawItemsSkill(facade),
    createPickupItemsSkill(facade),
    createAutoEatSkill(facade),
    createAttackHostileSkill(facade),
    createDefendSkill(facade),
    createLookAtSkill(facade),
    createWaitSkill(facade),
    createSaySkill(facade),
  ] as Array<Skill<never>>;

  const registry = new Map<ActionType, Skill<never>>();
  for (const skill of skills) {
    registry.set(skill.name, skill);
  }

  const missing = ACTION_TYPES.filter((type) => !registry.has(type));
  if (missing.length > 0) {
    throw new Error(`No skill registered for action type(s): ${missing.join(', ')}`);
  }
  return registry;
}

/** Looks up a skill, or undefined when the action type has no skill. */
export function getSkill(registry: SkillRegistry, type: ActionType): Skill<never> | undefined {
  return registry.get(type);
}

/** Conflict groups for an action, used by the task scheduler. */
export function conflictGroupsFor(registry: SkillRegistry, type: ActionType): readonly string[] {
  return registry.get(type)?.conflictGroups ?? [];
}

export { FollowPlayerSkill, createFollowPlayerSkill } from './movement/followPlayer.js';
export { GotoPlayerSkill, createGotoPlayerSkill } from './movement/gotoPlayer.js';
export { GotoPositionSkill, createGotoPositionSkill } from './movement/gotoPosition.js';
export { MineBlockSkill, createMineBlockSkill } from './mining/mineBlock.js';
export { CollectResourceSkill, createCollectResourceSkill } from './mining/collectResource.js';
export { PlaceBlockSkill, createPlaceBlockSkill } from './building/placeBlock.js';
export {
  BuildStructureSkill,
  createBuildStructureSkill,
  planStructure,
  STRUCTURE_TYPES,
} from './building/buildStructure.js';
export type { StructureType } from './building/buildStructure.js';
export { EquipItemSkill, createEquipItemSkill } from './inventory/equipItem.js';
export { DropItemSkill, createDropItemSkill } from './inventory/dropItem.js';
export {
  DepositItemsSkill,
  WithdrawItemsSkill,
  createDepositItemsSkill,
  createWithdrawItemsSkill,
  transferIntoChest,
  transferOutOfChest,
} from './inventory/chestManager.js';
export { AutoEatSkill, createAutoEatSkill } from './survival/autoEat.js';
export { PickupItemsSkill, createPickupItemsSkill } from './inventory/pickupItems.js';
export type { PickupItemsParams } from './inventory/pickupItems.js';
export { EscapeDangerSkill, createEscapeDangerSkill, detectDanger } from './survival/escapeDanger.js';
export { DefendSkill, createDefendSkill } from './survival/defend.js';
export { AttackHostileSkill, createAttackHostileSkill } from './combat/attackHostile.js';
export { StopSkill, createStopSkill } from './basic/stop.js';
export { SaySkill, createSaySkill } from './basic/say.js';
export { LookAtSkill, createLookAtSkill } from './basic/lookAt.js';
export { WaitSkill, createWaitSkill } from './basic/wait.js';
export { runMining, resolveResourceNames, MAX_BLOCKS_PER_TASK } from './mining/shared.js';