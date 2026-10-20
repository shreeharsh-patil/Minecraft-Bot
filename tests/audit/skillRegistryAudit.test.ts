/**
 * Audit of the skill registry and the shared skill helpers.
 *
 * Every test here is a regression test: it fails on the code as it was and
 * passes on the code as it is now.
 */
import { describe, expect, it } from 'vitest';
import { ACTION_TYPES } from '../../src/types/actions.js';
import type { ActionType } from '../../src/types/actions.js';
import type { Skill } from '../../src/types/skill.js';
import { buildSkillRegistry, createSkillRegistry, getSkill } from '../../src/skills/index.js';
import { clamp, entityOccupiesCell, normaliseBlockName } from '../../src/skills/internal/helpers.js';
import { EquipItemSkill } from '../../src/skills/inventory/equipItem.js';
import { PlaceBlockSkill } from '../../src/skills/building/placeBlock.js';
import { resolveResourceNames } from '../../src/skills/mining/shared.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';

function fakeSkill(name: ActionType): Skill<never> {
  return {
    name,
    conflictGroups: ['none'],
    execute: () => Promise.resolve({ ok: true }),
  };
}

describe('the registry fails fast at construction', () => {
  it('resolves every action type', () => {
    const registry = createSkillRegistry(new FakeMinecraftFacade());

    for (const type of ACTION_TYPES) {
      expect(getSkill(registry, type), `missing skill for ${type}`).toBeDefined();
    }
    expect(registry.size).toBe(ACTION_TYPES.length);
  });

  it('refuses two skills that claim the same action type', () => {
    // The second "say" skill would silently shadow the first one: the action
    // would resolve to the wrong skill in game, with nothing complaining.
    const skills = [...ACTION_TYPES.map(fakeSkill), fakeSkill('say')];

    expect(() => buildSkillRegistry(skills)).toThrow(/two skills/i);
  });

  it('refuses an action type that has no skill', () => {
    const skills = ACTION_TYPES.filter((type) => type !== 'say').map(fakeSkill);

    expect(() => buildSkillRegistry(skills)).toThrow(/say/);
  });
});

describe('normaliseBlockName - the model says "oak logs", Minecraft says "oak_log"', () => {
  it('folds the plural back to the singular id', () => {
    expect(normaliseBlockName('oak logs')).toBe('oak_log');
    expect(normaliseBlockName('Oak-Log')).toBe('oak_log');
    expect(normaliseBlockName('iron ingots')).toBe('iron_ingot');
    expect(normaliseBlockName('diamond swords')).toBe('diamond_sword');
  });

  it('leaves the names that really are plural alone', () => {
    expect(normaliseBlockName('sweet_berries')).toBe('sweet_berries');
    expect(normaliseBlockName('glow berries')).toBe('glow_berries');
    expect(normaliseBlockName('bricks')).toBe('bricks');
    expect(normaliseBlockName('oak planks')).toBe('oak_planks');
    expect(normaliseBlockName('glass')).toBe('glass');
    expect(normaliseBlockName('sand')).toBe('sand');
  });

  it('equips the item the bot is really carrying', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { oak_log: 3 } });
    const skill = new EquipItemSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'oak logs' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.heldItem()).toBe('oak_log');
  });

  it('still resolves the mining names the same way', () => {
    // The mining path folds the plural itself; the normaliser must not break it.
    expect(resolveResourceNames('oak logs')).toEqual(['oak_log']);
    expect(resolveResourceNames('iron ores')).toEqual(['iron_ore']);
    expect(resolveResourceNames('cobblestone')).toEqual(['cobblestone']);
  });
});

describe('entityOccupiesCell - a player in the cell is a player in the cell', () => {
  const farCell = { x: 20, y: 64, z: 0 };

  it('finds somebody standing in a cell the bot has not walked to yet', () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [
        { name: 'Alice', type: 'player', distance: 20, position: { x: 20, y: 64, z: 0 } },
      ],
    });

    const occupant = entityOccupiesCell(facade, farCell);

    expect(occupant?.name).toBe('Alice');
  });

  it('does not build a block inside a player standing far away', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      inventory: { cobblestone: 5 },
      entities: [
        { name: 'Alice', type: 'player', distance: 20, position: { x: 20, y: 64, z: 0 } },
      ],
    });
    const skill = new PlaceBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'cobblestone', position: farCell }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/standing there|Alice/i);
    expect(facade.placedPositions).toHaveLength(0);
  });

  it('still ignores dropped items and other clutter', () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [
        { name: 'item', type: 'other', distance: 20, position: { x: 20, y: 64, z: 0 } },
      ],
    });

    expect(entityOccupiesCell(facade, farCell)).toBeNull();
  });
});

describe('clamp', () => {
  it('clamps an infinite value to the end it is beyond', () => {
    expect(clamp(Number.POSITIVE_INFINITY, 0, 10)).toBe(10);
    expect(clamp(Number.NEGATIVE_INFINITY, 0, 10)).toBe(0);
  });

  it('falls back to the low end for NaN, which has no direction', () => {
    expect(clamp(Number.NaN, 0, 10)).toBe(0);
  });

  it('clamps a normal value into the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });
});
