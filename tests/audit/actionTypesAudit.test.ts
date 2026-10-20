/**
 * Audit of the action / skill / task contracts:
 * `src/types/actions.ts`, `src/types/skill.ts`, `src/types/task.ts`.
 *
 * The defects pinned here:
 *
 *  - the allowlist was a plain array, so "closed" was only true in the type
 *    system: anything could push a new action type into it at runtime, and
 *    `isActionType` would then accept it;
 *  - `BotAction` was a hand-written union kept next to `ACTION_TYPES`, so
 *    the allowlist and the action shapes could drift apart. An allowlisted
 *    type without a shape is a runtime surprise in the validator ("unhandled
 *    action type"), not a compile error;
 *  - `SkillInput` typed the action as `unknown`, so the one other "how a
 *    skill is called" contract in the public surface could not be checked at
 *    all;
 *  - the conflict-group vocabulary was not checkable. The scheduler
 *    arbitrates on the exact group name, so a typo ("move" instead of
 *    "movement") does not just look wrong: it creates a SECOND group that
 *    never arbitrates against the real one, and two tasks that both need the
 *    body end up running at the same time.
 *
 * The type-level assertions below are enforced by `tsc --noEmit`: an
 * `@ts-expect-error` that stops being an error fails the typecheck.
 */
import { describe, expect, it } from 'vitest';
import { ACTION_TYPES, isActionType } from '../../src/types/actions.js';
import type { ActionShapeMap, ActionType, BotAction } from '../../src/types/actions.js';
import type { SkillInput } from '../../src/types/skill.js';
import { CONFLICT_GROUP, CONFLICT_GROUPS, isConflictGroup } from '../../src/types/task.js';
import type { ExecutionContext, TaskRecord } from '../../src/types/task.js';
import { validateAction } from '../../src/executor/validator.js';
import { conflictGroupsFor, createSkillRegistry, getSkill } from '../../src/skills/index.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';

/** The smallest raw action the validator accepts for each action type. */
const MINIMAL: Record<ActionType, Record<string, unknown>> = {
  move_to_player: { type: 'move_to_player', player: 'Alice' },
  move_to_position: { type: 'move_to_position', position: { x: 1, y: 64, z: 2 } },
  follow_player: { type: 'follow_player', player: 'Alice' },
  stop: { type: 'stop' },
  look_at: { type: 'look_at', position: { x: 1, y: 64, z: 2 } },
  wait: { type: 'wait', durationMs: 10 },
  say: { type: 'say', message: 'on my way' },
  mine_block: { type: 'mine_block', blockName: 'oak_log', count: 1 },
  collect_resource: { type: 'collect_resource', resource: 'oak logs', count: 1 },
  equip_item: { type: 'equip_item', item: 'stone_pickaxe' },
  drop_item: { type: 'drop_item', item: 'dirt' },
  deposit_items: { type: 'deposit_items' },
  withdraw_items: { type: 'withdraw_items' },
  pickup_items: { type: 'pickup_items' },
  place_block: { type: 'place_block', blockName: 'stone', position: { x: 1, y: 64, z: 2 } },
  build_structure: {
    type: 'build_structure',
    structure: 'wall',
    position: { x: 1, y: 64, z: 2 },
    dimensions: { length: 2, height: 2 },
  },
  eat: { type: 'eat' },
  attack_hostile: { type: 'attack_hostile' },
  defend_player: { type: 'defend_player', player: 'Alice' },
};

function fakeContext(): ExecutionContext {
  return {
    task: {} as TaskRecord,
    signal: new AbortController().signal,
    progress: () => undefined,
    say: () => undefined,
  };
}

/**
 * Type-level checks. `BotAction` is derived from `ActionShapeMap`, so an
 * action type without a shape is a compile error in `src/types/actions.ts`
 * rather than a runtime "unhandled action type" in the validator.
 *
 * `ActionShapeMap[ActionType]` only compiles when the map covers the whole
 * allowlist - that is the drift guard.
 */
export type _AllShapes = ActionShapeMap[ActionType];
// @ts-expect-error - 'not_an_action' is not an action type, so the map has no entry for it.
export type _NoShapeFor = ActionShapeMap['not_an_action'];

describe('audit: the action allowlist is closed', () => {
  it('is frozen, so nothing can push a new action type into it', () => {
    expect(Object.isFrozen(ACTION_TYPES)).toBe(true);
    expect(() => (ACTION_TYPES as unknown as string[]).push('sneak_attack')).toThrow();
  });

  it('still refuses an action type that is not on the list', () => {
    expect(isActionType('sneak_attack')).toBe(false);
    expect(isActionType('mine_block')).toBe(true);
  });
});

describe('audit: the allowlist and the action shapes agree', () => {
  it('has a validator that produces every allowlisted action', () => {
    for (const type of ACTION_TYPES) {
      const result = validateAction(MINIMAL[type]);
      expect(result.valid, `no validator for ${type}`).toBe(true);
      expect(result.action?.type, `validator produced the wrong type for ${type}`).toBe(type);
    }
  });

  it('has a registered skill for every allowlisted action', () => {
    const registry = createSkillRegistry(new FakeMinecraftFacade());
    for (const type of ACTION_TYPES) {
      expect(getSkill(registry, type), `no skill for ${type}`).toBeDefined();
    }
  });
});

describe('audit: the conflict-group vocabulary is checkable', () => {
  it('knows exactly the groups the scheduler arbitrates on', () => {
    expect([...CONFLICT_GROUPS].sort()).toEqual(
      ['building', 'combat', 'inventory', 'mining', 'movement', 'none'].sort(),
    );
    expect(isConflictGroup(CONFLICT_GROUP.MOVEMENT)).toBe(true);
    expect(isConflictGroup(CONFLICT_GROUP.NONE)).toBe(true);
  });

  it('rejects a group name that is not in the vocabulary', () => {
    // A typo is not a harmless mistake: it is a second group that never
    // arbitrates against the real one.
    expect(isConflictGroup('move')).toBe(false);
    expect(isConflictGroup('minning')).toBe(false);
    expect(isConflictGroup('Movement')).toBe(false);
    expect(isConflictGroup(42)).toBe(false);
    expect(isConflictGroup(undefined)).toBe(false);
  });

  it('is used by every registered skill', () => {
    const registry = createSkillRegistry(new FakeMinecraftFacade());
    for (const type of ACTION_TYPES) {
      for (const group of conflictGroupsFor(registry, type)) {
        expect(isConflictGroup(group), `${type} declares the unknown group "${group}"`).toBe(true);
      }
    }
  });
});

describe('audit: the skill input contract is checked', () => {
  it('takes a bot action, not anything at all', () => {
    const badInput: SkillInput = {
      // @ts-expect-error - `action` must be a bot action, not `unknown`.
      action: { type: 'not_an_action' },
      ctx: fakeContext(),
    };
    expect(badInput).toBeDefined();
  });

  it('takes the action of the skill it belongs to', () => {
    const input: SkillInput = { action: { type: 'stop' }, ctx: fakeContext() };
    expect(input.action.type).toBe('stop');
  });
});

describe('audit: the action union is derived from the shape map', () => {
  it('keeps every allowlisted type in the union', () => {
    const oneOfEach: BotAction[] = ACTION_TYPES.map((type) => MINIMAL[type] as unknown as BotAction);
    expect(oneOfEach).toHaveLength(ACTION_TYPES.length);
    expect(oneOfEach.map((action) => action.type).sort()).toEqual([...ACTION_TYPES].sort());
  });
});
