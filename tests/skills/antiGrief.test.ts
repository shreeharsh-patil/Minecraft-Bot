/**
 * The anti-grief rules, enforced where the world actually changes.
 *
 * The bot works on a server shared with real players, so it must never
 * quietly dismantle their work: no breaking a chest, no overwriting a block
 * that is already there, no building inside a player and no filling somebody
 * else's chest with its own loot.
 */
import { describe, expect, it } from 'vitest';
import { MineBlockSkill } from '../../src/skills/mining/mineBlock.js';
import { CollectResourceSkill } from '../../src/skills/mining/collectResource.js';
import { PlaceBlockSkill } from '../../src/skills/building/placeBlock.js';
import { BuildStructureSkill } from '../../src/skills/building/buildStructure.js';
import { DepositItemsSkill } from '../../src/skills/inventory/chestManager.js';
import { FakeMinecraftFacade } from './fakes/fakeFacade.js';
import { createTestContext } from './helpers/testContext.js';

const CHEST = { x: 2, y: 64, z: 0 };

describe('Anti-grief - mining', () => {
  it('refuses to break a chest, so a player keeps their chest', async () => {
    const facade = new FakeMinecraftFacade({ blocks: [{ name: 'chest', at: CHEST }] });
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'chest', count: 1 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/player structure block/i);
    expect(facade.dugPositions).toHaveLength(0);
    expect(facade.getBlockAt(CHEST)).toBe('chest');
  });

  it('refuses to break a protected block such as farmland', async () => {
    const facade = new FakeMinecraftFacade({ blocks: [{ name: 'farmland', at: CHEST }] });
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'farmland', count: 1 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/protected block/i);
    expect(facade.dugPositions).toHaveLength(0);
  });

  it('still mines natural terrain', async () => {
    const facade = new FakeMinecraftFacade({
      inventory: { iron_axe: 1 },
      blocks: [{ name: 'oak_log', at: { x: 3, y: 64, z: 0 } }],
      tools: { oak_log: 'iron_axe' },
    });
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'oak_log', count: 1 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.dugPositions).toHaveLength(1);
  });

  it('refuses to collect a player structure through the resource path too', async () => {
    const facade = new FakeMinecraftFacade({ blocks: [{ name: 'chest', at: CHEST }] });
    const skill = new CollectResourceSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ resource: 'chest', count: 1 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.dugPositions).toHaveLength(0);
  });
});

describe('Anti-grief - placing', () => {
  it('refuses to overwrite a block that is already there', async () => {
    const facade = new FakeMinecraftFacade({
      inventory: { cobblestone: 5 },
      blocks: [{ name: 'stone', at: { x: 1, y: 64, z: 0 } }],
    });
    const skill = new PlaceBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { blockName: 'cobblestone', position: { x: 1, y: 64, z: 0 } },
      test.ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/occupied by "stone"/i);
    expect(facade.placedPositions).toHaveLength(0);
    expect(facade.getBlockAt({ x: 1, y: 64, z: 0 })).toBe('stone');
  });

  it('refuses a dangerous material such as tnt', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { tnt: 5 } });
    const skill = new PlaceBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { blockName: 'tnt', position: { x: 2, y: 64, z: 0 } },
      test.ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/dangerous/i);
    expect(facade.placedPositions).toHaveLength(0);
  });

  it('refuses to build inside a player', async () => {
    const facade = new FakeMinecraftFacade({
      inventory: { cobblestone: 5 },
      entities: [
        { name: 'Alice', type: 'player', distance: 2, position: { x: 2, y: 64, z: 0 } },
      ],
    });
    const skill = new PlaceBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { blockName: 'cobblestone', position: { x: 2, y: 64, z: 0 } },
      test.ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/standing there/i);
    expect(facade.placedPositions).toHaveLength(0);
  });

  it('refuses to build a structure out of a dangerous material', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { tnt: 40 } });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      {
        structure: 'wall',
        position: { x: 0, y: 64, z: 0 },
        dimensions: { length: 2, height: 2 },
        material: 'tnt',
      },
      test.ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/dangerous/i);
    expect(facade.placedPositions).toHaveLength(0);
  });
});

describe('Anti-grief - building', () => {
  it('reports placed and skipped blocks separately', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 16 } });
    // Two of the four cells of the platform already hold the material.
    facade.addBlock('cobblestone', { x: 0, y: 64, z: 0 });
    facade.addBlock('cobblestone', { x: 1, y: 64, z: 0 });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { structure: 'platform', position: { x: 0, y: 64, z: 0 }, dimensions: { length: 2, width: 2 } },
      test.ctx,
    );

    // Only the two missing blocks were placed...
    expect(result.count).toBe(2);
    expect(facade.placedPositions).toHaveLength(2);
    // ...and the summary says so.
    expect(result.detail).toMatch(/placed 2 of 4/i);
    expect(result.detail).toMatch(/skipped 2/i);
  });

  it('skips a cell somebody is standing in', async () => {
    const facade = new FakeMinecraftFacade({
      inventory: { cobblestone: 16 },
      entities: [
        { name: 'Alice', type: 'player', distance: 1, position: { x: 1, y: 64, z: 0 } },
      ],
    });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { structure: 'platform', position: { x: 0, y: 64, z: 0 }, dimensions: { length: 2, width: 2 } },
      test.ctx,
    );

    expect(result.count).toBe(3);
    expect(result.detail).toMatch(/skipped 1/i);
  });

  it('does not ask for material it does not need', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 2 } });
    // Two of the four cells already hold the material.
    facade.addBlock('cobblestone', { x: 0, y: 64, z: 0 });
    facade.addBlock('cobblestone', { x: 1, y: 64, z: 0 });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { structure: 'platform', position: { x: 0, y: 64, z: 0 }, dimensions: { length: 2, width: 2 } },
      test.ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(facade.countItem('cobblestone')).toBe(0);
  });
});

describe('Anti-grief - chests', () => {
  it('refuses to store items in a chest a player is using', async () => {
    const facade = new FakeMinecraftFacade({
      inventory: { cobblestone: 32 },
      chests: [{ at: CHEST, items: {} }],
      players: [{ name: 'Alice', distance: 1, position: { x: 3, y: 64, z: 0 }, authorized: true }],
    });
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/player-owned chest/i);
    // Nothing was stored.
    expect(facade.chestContents(CHEST)['cobblestone']).toBeUndefined();
    expect(facade.countItem('cobblestone')).toBe(32);
  });

  it('stores items in an unclaimed chest', async () => {
    const facade = new FakeMinecraftFacade({
      inventory: { cobblestone: 32 },
      chests: [{ at: CHEST, items: {} }],
    });
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.chestContents(CHEST)['cobblestone']).toBe(32);
  });
});
