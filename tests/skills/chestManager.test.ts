import { describe, expect, it } from 'vitest';
import { DepositItemsSkill, WithdrawItemsSkill } from '../../src/skills/inventory/chestManager.js';
import { DropItemSkill } from '../../src/skills/inventory/dropItem.js';
import { FakeMinecraftFacade } from './fakes/fakeFacade.js';
import { createTestContext } from './helpers/testContext.js';

const CHEST = { x: 2, y: 64, z: 0 };

function worldWithChest(inventory: Record<string, number>, chestItems: Record<string, number> = {}): FakeMinecraftFacade {
  return new FakeMinecraftFacade({
    position: { x: 0, y: 64, z: 0 },
    inventory,
    chests: [{ at: CHEST, items: chestItems }],
  });
}

describe('DepositItemsSkill', () => {
  it('reports the correct number of items deposited', async () => {
    const facade = worldWithChest({ cobblestone: 64, dirt: 10 });
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(64);
    expect(result.detail).toMatch(/Stored 64/);
    expect(facade.countItem('cobblestone')).toBe(0);
    expect(facade.chestContents(CHEST)['cobblestone']).toBe(64);
    // Unrelated stacks stay in the inventory.
    expect(facade.countItem('dirt')).toBe(10);
  });

  it('deposits only the requested count', async () => {
    const facade = worldWithChest({ cobblestone: 64 });
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone', count: 20 }, test.ctx);

    expect(result.count).toBe(20);
    expect(facade.countItem('cobblestone')).toBe(44);
    expect(facade.chestContents(CHEST)['cobblestone']).toBe(20);
  });

  it('fills an existing chest stack to 64 before opening a new one', async () => {
    const facade = worldWithChest({ dirt: 10 }, { dirt: 60 });
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'dirt', count: 10 }, test.ctx);

    expect(result.count).toBe(10);
    expect(facade.chestContents(CHEST)['dirt']).toBe(70);
    // 4 tops up the existing stack to 64, the remaining 6 opens a new stack.
    expect(facade.depositTrace).toEqual([4, 6]);
  });

  it('never claims more than a full chest can take', async () => {
    const facade = worldWithChest({ dirt: 100 });
    facade.chestCapacity = 30;
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'dirt', count: 100 }, test.ctx);

    expect(result.count).toBe(30);
    expect(facade.countItem('dirt')).toBe(70);
  });

  it('reports gracefully when there is no chest nearby', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { dirt: 10 } });
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'dirt' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/couldn't find a chest/i);
    expect(facade.countItem('dirt')).toBe(10);
  });

  it('reports when the bot does not carry the item', async () => {
    const facade = worldWithChest({ dirt: 10 });
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'diamond' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/don't have any/i);
  });

  it('is cancellable mid-transfer', async () => {
    const facade = worldWithChest({ dirt: 10 });
    facade.moveDelayMs = 50;
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const running = skill.execute({ item: 'dirt' }, test.ctx);
    setTimeout(() => test.abort(), 20);

    const result = await running;

    expect(result.ok).toBe(false);
    expect(facade.countItem('dirt')).toBe(10);
    expect(facade.chestContents(CHEST)['dirt']).toBeUndefined();
  });
});

describe('WithdrawItemsSkill', () => {
  it('takes the requested amount out of the chest', async () => {
    const facade = worldWithChest({}, { cobblestone: 64 });
    const skill = new WithdrawItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone', count: 16 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(16);
    expect(facade.countItem('cobblestone')).toBe(16);
    expect(facade.chestContents(CHEST)['cobblestone']).toBe(48);
  });

  it('stops when the inventory is full', async () => {
    const facade = worldWithChest({ dirt: 5 }, { cobblestone: 64 });
    facade.inventoryFull = true;
    const skill = new WithdrawItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone', count: 10 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/inventory is full/i);
    expect(facade.chestContents(CHEST)['cobblestone']).toBe(64);
  });

  it('reports when the chest has nothing of that item', async () => {
    const facade = worldWithChest({}, { sand: 10 });
    const skill = new WithdrawItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no cobblestone in that chest/i);
  });

  it('falls back to the nearest chest when a named location is given', async () => {
    const facade = worldWithChest({}, { cobblestone: 8 });
    const skill = new WithdrawItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone', location: 'home' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(8);
    expect(test.messages.join(' ')).toMatch(/nearest chest/i);
  });
});

describe('DropItemSkill', () => {
  it('drops the requested count on the floor', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { dirt: 20 } });
    const skill = new DropItemSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'dirt', count: 5 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(5);
    expect(facade.countItem('dirt')).toBe(15);
    expect(facade.dropped).toEqual([{ item: 'dirt', count: 5 }]);
  });

  it('clamps the request to what is carried', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { dirt: 3 } });
    const skill = new DropItemSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'dirt', count: 99 }, test.ctx);

    expect(result.count).toBe(3);
    expect(facade.countItem('dirt')).toBe(0);
  });

  it('routes to a chest when asked', async () => {
    const facade = worldWithChest({ dirt: 12 });
    const skill = new DropItemSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'dirt', count: 12, where: 'chest' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(12);
    expect(facade.chestContents(CHEST)['dirt']).toBe(12);
  });
});