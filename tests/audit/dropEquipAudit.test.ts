/**
 * Audit tests for the `drop_item` and `equip_item` skills.
 *
 * They pin down the two promises those skills make:
 *  - a drop reports exactly how many items moved and how many are left;
 *  - an equip is only reported as done once the item really is in the hand.
 */
import { describe, expect, it } from 'vitest';
import { DropItemSkill } from '../../src/skills/inventory/dropItem.js';
import { EquipItemSkill } from '../../src/skills/inventory/equipItem.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';

const CHEST = { x: 2, y: 64, z: 0 };

function worldWithChest(inventory: Record<string, number>): FakeMinecraftFacade {
  return new FakeMinecraftFacade({
    position: { x: 0, y: 64, z: 0 },
    inventory,
    chests: [{ at: CHEST, items: {} }],
  });
}

/** A facade that claims the equip worked but never puts anything in the hand. */
class LyingFacade extends FakeMinecraftFacade {
  public override equipItem(item: string): Promise<boolean> {
    this.calls.push(`equipItem:${item}`);
    return Promise.resolve(true);
  }
}

/** A facade where the server only confirms half of the requested drop. */
class PartialDropFacade extends FakeMinecraftFacade {
  public override async dropItem(item: string, count: number): Promise<number> {
    return super.dropItem(item, Math.floor(count / 2));
  }
}

describe('DropItemSkill - what it reports', () => {
  it('drops the requested count and leaves nothing outstanding', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { dirt: 20 } });
    const skill = new DropItemSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'dirt', count: 5 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(5);
    expect(result.remaining).toBeUndefined();
    expect(facade.countItem('dirt')).toBe(15);
  });

  it('reports how much of a chest deposit is left over', async () => {
    const facade = worldWithChest({ dirt: 5 });
    // The chest can only take two of the five.
    facade.chestCapacity = 2;
    const skill = new DropItemSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'dirt', count: 5, where: 'chest' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.remaining).toBe(3);
    // The message has to say that only part of the request was honoured.
    expect(result.detail).toMatch(/of 5/);
    expect(facade.countItem('dirt')).toBe(3);
  });

  it('reports the remainder when the chest takes nothing at all', async () => {
    const facade = worldWithChest({ dirt: 5 });
    // A completely full chest.
    facade.chestCapacity = 0;
    const skill = new DropItemSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'dirt', count: 5, where: 'chest' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.count).toBe(0);
    expect(result.remaining).toBe(5);
    expect(facade.countItem('dirt')).toBe(5);
  });

  it('reports the remainder when only part of the floor drop is confirmed', async () => {
    const facade = new PartialDropFacade({ inventory: { dirt: 10 } });
    const skill = new DropItemSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'dirt', count: 6 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
    expect(result.remaining).toBe(3);
  });

  it('reports the remainder when the drop is cancelled', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { dirt: 4 } });
    const skill = new DropItemSkill(facade);
    const test = createTestContext();
    test.abort();

    const result = await skill.execute({ item: 'dirt', count: 4 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.count).toBe(0);
    expect(result.remaining).toBe(4);
    expect(facade.countItem('dirt')).toBe(4);
  });
});

describe('EquipItemSkill - what it reports', () => {
  it('equips an item that is in the inventory', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { diamond_pickaxe: 1 } });
    const skill = new EquipItemSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'diamond_pickaxe' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(facade.heldItem()).toBe('diamond_pickaxe');
  });

  it('does not claim an equip that never reached the hand', async () => {
    const facade = new LyingFacade({ inventory: { iron_sword: 1 } });
    const skill = new EquipItemSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'iron_sword' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.heldItem()).toBeNull();
  });

  it('counts one item when the item is already in hand', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { dirt: 5 } });
    const skill = new EquipItemSkill(facade);
    const test = createTestContext();

    await skill.execute({ item: 'dirt' }, test.ctx);
    const result = await skill.execute({ item: 'dirt' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
  });
});
