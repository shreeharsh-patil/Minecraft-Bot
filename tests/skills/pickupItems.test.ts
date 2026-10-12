import { describe, expect, it } from 'vitest';
import { PickupItemsSkill } from '../../src/skills/inventory/pickupItems.js';
import { FakeMinecraftFacade } from './fakes/fakeFacade.js';
import { createTestContext } from './helpers/testContext.js';

/** A flat world with stacks lying on the ground at the given spots. */
function worldWithDrops(
  drops: Array<{ name: string; at: { x: number; y: number; z: number } }>,
): FakeMinecraftFacade {
  return new FakeMinecraftFacade({ position: { x: 0, y: 64, z: 0 }, droppedItems: drops });
}

describe('PickupItemsSkill', () => {
  it('walks onto a dropped stack and reports the inventory delta', async () => {
    const facade = worldWithDrops([{ name: 'iron_ingot', at: { x: 4, y: 64, z: 0 } }]);
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(facade.countItem('iron_ingot')).toBe(1);
    expect(facade.droppedItemPositions()).toHaveLength(0);
  });

  it('only collects the filtered item', async () => {
    const facade = worldWithDrops([
      { name: 'dirt', at: { x: 1, y: 64, z: 0 } },
      { name: 'diamond', at: { x: 6, y: 64, z: 0 } },
    ]);
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'diamond' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.countItem('diamond')).toBe(1);
    expect(facade.countItem('dirt')).toBe(0);
    // The dirt stack is still exactly where it was left.
    expect(facade.droppedItemPositions()).toHaveLength(1);
  });

  it('stops as soon as the requested count is satisfied', async () => {
    const facade = worldWithDrops([
      { name: 'cobblestone', at: { x: 2, y: 64, z: 0 } },
      { name: 'cobblestone', at: { x: 4, y: 64, z: 0 } },
      { name: 'cobblestone', at: { x: 6, y: 64, z: 0 } },
    ]);
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone', count: 2 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.countItem('cobblestone')).toBe(2);
    expect(facade.pickedUp).toHaveLength(2);
    // The third stack is untouched.
    expect(facade.droppedItemPositions()).toHaveLength(1);
  });

  it('normalises a loosely spelled item name, e.g. "Iron-Ingot"', async () => {
    const facade = worldWithDrops([{ name: 'iron_ingot', at: { x: 3, y: 64, z: 0 } }]);
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'Iron-Ingot' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.countItem('iron_ingot')).toBe(1);
  });

  it('collects nothing when the item name does not match a dropped stack', async () => {
    // An unmatched filter must never degrade into "collect everything".
    const facade = worldWithDrops([{ name: 'iron_ingot', at: { x: 2, y: 64, z: 0 } }]);
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'diamond' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.pickedUp).toHaveLength(0);
    expect(facade.countItem('iron_ingot')).toBe(0);
  });

  it('ignores stacks outside the search radius', async () => {
    const facade = worldWithDrops([{ name: 'iron_ingot', at: { x: 30, y: 64, z: 0 } }]);
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ radius: 4 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/could not find any dropped/i);
    expect(facade.moveToPositionCalls).toHaveLength(0);
  });

  it('reports an unreachable stack instead of retrying it forever', async () => {
    const facade = worldWithDrops([{ name: 'iron_ingot', at: { x: 4, y: 64, z: 0 } }]);
    facade.unreachable.add('4,64,0');
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/could not pick it up/i);
    // One walk attempt, not an unbounded retry of the same hole.
    expect(facade.moveToPositionCalls.length).toBeLessThanOrEqual(3);
  });

  it('reports a shortfall when the ground holds less than requested', async () => {
    const facade = worldWithDrops([{ name: 'oak_log', at: { x: 3, y: 64, z: 0 } }]);
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'oak_log', count: 5 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.count).toBe(1);
    expect(result.remaining).toBe(4);
  });

  it('does not pretend to collect when the inventory is full', async () => {
    const facade = worldWithDrops([{ name: 'iron_ingot', at: { x: 2, y: 64, z: 0 } }]);
    facade.inventoryFull = true;
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.countItem('iron_ingot')).toBe(0);
  });

  it('aborts promptly when !stop fires mid-walk', async () => {
    const facade = worldWithDrops([{ name: 'iron_ingot', at: { x: 8, y: 64, z: 0 } }]);
    facade.moveDelayMs = 5_000;
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const running = skill.execute({}, test.ctx);
    setTimeout(() => test.abort(), 20);

    const result = await running;

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Stopped collecting/i);
    expect(facade.countItem('iron_ingot')).toBe(0);
  });
});
