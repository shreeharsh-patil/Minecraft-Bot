import { describe, expect, it } from 'vitest';
import { BuildStructureSkill, planStructure, STRUCTURE_TYPES } from '../../src/skills/building/buildStructure.js';
import { PlaceBlockSkill } from '../../src/skills/building/placeBlock.js';
import { EquipItemSkill } from '../../src/skills/inventory/equipItem.js';
import { FakeMinecraftFacade } from './fakes/fakeFacade.js';
import { createTestContext } from './helpers/testContext.js';

const ORIGIN = { x: 0, y: 64, z: 0 };

describe('planStructure', () => {
  it('only supports the three whitelisted structures', () => {
    expect([...STRUCTURE_TYPES]).toEqual(['wall', 'platform', 'simple_house']);
  });

  it('expands a wall into length x height blocks', () => {
    const positions = planStructure('wall', ORIGIN, { length: 5, height: 3 });
    expect(positions).toHaveLength(15);
    expect(positions[0]).toEqual({ x: 0, y: 64, z: 0 });
  });

  it('clamps absurd dimensions to the caps', () => {
    const positions = planStructure('wall', ORIGIN, { length: 10_000, height: 10_000 });
    // 24 x 12 caps
    expect(positions).toHaveLength(24 * 12);
  });

  it('leaves a doorway in a simple house', () => {
    const positions = planStructure('simple_house', ORIGIN, { size: 5, height: 4 });
    const door = { x: ORIGIN.x + 2, y: ORIGIN.y + 1, z: ORIGIN.z + 4 };
    expect(positions.some((p) => p.x === door.x && p.y === door.y && p.z === door.z)).toBe(false);
  });
});

describe('BuildStructureSkill', () => {
  it('fails clearly when the bot lacks the material', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 3 } });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { structure: 'wall', position: ORIGIN, dimensions: { length: 5, height: 3 } },
      test.ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/need 15 cobblestone but I only have 3/);
    expect(facade.placedPositions).toHaveLength(0);
  });

  it('rejects a structure outside the whitelist', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 999 } });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { structure: 'castle' as 'wall', position: ORIGIN, dimensions: {} },
      test.ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/wall, platform, simple_house/);
  });

  it('builds a platform and reports progress', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 16 } });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { structure: 'platform', position: ORIGIN, dimensions: { length: 4, width: 4 } },
      test.ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.count).toBe(16);
    expect(facade.placedPositions).toHaveLength(16);
    expect(facade.countItem('cobblestone')).toBe(0);
    expect(test.progressUpdates.at(-1)?.fraction).toBe(1);
  });

  it('stops building when aborted', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 200 } });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    const running = skill.execute(
      { structure: 'platform', position: ORIGIN, dimensions: { length: 16, width: 16 } },
      test.ctx,
    );
    test.abort();

    const result = await running;

    expect(result.ok).toBe(false);
    expect(facade.placedPositions.length).toBeLessThan(256);
  });

  it('does not overwrite a block that is already in the way', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 16 } });
    facade.addBlock('bedrock', { x: 1, y: 64, z: 0 });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    await skill.execute(
      { structure: 'platform', position: ORIGIN, dimensions: { length: 2, width: 2 } },
      test.ctx,
    );

    expect(facade.getBlockAt({ x: 1, y: 64, z: 0 })).toBe('bedrock');
    expect(facade.placedPositions).toHaveLength(3);
  });
});

describe('PlaceBlockSkill', () => {
  it('places one block where asked', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 5 } });
    const skill = new PlaceBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'cobblestone', position: { x: 3, y: 64, z: 0 } }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(facade.getBlockAt({ x: 3, y: 64, z: 0 })).toBe('cobblestone');
    expect(facade.countItem('cobblestone')).toBe(4);
  });

  it('reports when the bot has none of that block', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new PlaceBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'cobblestone', position: ORIGIN }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/don't have any cobblestone/i);
  });

  it('refuses to overwrite an existing block', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 5 } });
    facade.addBlock('stone', { x: 1, y: 64, z: 0 });
    const skill = new PlaceBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'cobblestone', position: { x: 1, y: 64, z: 0 } }, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.getBlockAt({ x: 1, y: 64, z: 0 })).toBe('stone');
  });
});

describe('EquipItemSkill', () => {
  it('equips an item in the inventory', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { diamond_pickaxe: 1 } });
    const skill = new EquipItemSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'diamond_pickaxe' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.heldItem()).toBe('diamond_pickaxe');
  });

  it('reports when the item is not carried', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new EquipItemSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'shield' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/don't have any shield/i);
  });
});