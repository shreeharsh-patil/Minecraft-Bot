/**
 * Combat and inventory edge cases.
 *
 *  - `attack_hostile` must fight the mob where it IS, not where it was when
 *    the action started;
 *  - `pickup_items` must say "my inventory is full" instead of blaming the
 *    navigation when nothing came in because there was nowhere to put it.
 */
import { describe, expect, it } from 'vitest';
import { AttackHostileSkill } from '../../src/skills/combat/attackHostile.js';
import { PickupItemsSkill } from '../../src/skills/inventory/pickupItems.js';
import { FakeMinecraftFacade } from './fakes/fakeFacade.js';
import { createTestContext } from './helpers/testContext.js';

describe('AttackHostileSkill - the target moves', () => {
  it('fights the mob where it is now, not where it was', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [{ name: 'zombie', type: 'hostile', distance: 4, position: { x: 4, y: 64, z: 0 } }],
    });

    // The mob walks away while the bot is closing in on it.
    const originalMove = facade.moveToPosition.bind(facade);
    let first = true;
    facade.moveToPosition = async (target, options) => {
      const result = await originalMove(target, options);
      if (first) {
        first = false;
        facade.moveEntity('zombie', { x: 12, y: 64, z: 0 });
      }
      return result;
    };

    const skill = new AttackHostileSkill(facade);
    const test = createTestContext();

    const running = skill.execute({}, test.ctx);
    await new Promise((resolve) => setTimeout(resolve, 700));
    test.abort();
    await running;

    // The bot chased the mob to where it had moved to.
    expect(facade.moveToPositionCalls.some((call) => call.target.x === 12)).toBe(true);
  });
});

describe('PickupItemsSkill - a full inventory', () => {
  it('says the inventory is full instead of blaming the walk', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      droppedItems: [{ name: 'iron_ingot', at: { x: 2, y: 64, z: 0 } }],
    });
    facade.inventoryFull = true;
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/inventory is full/i);
    expect(result.detail).not.toMatch(/could not reach/i);
    expect(facade.countItem('iron_ingot')).toBe(0);
  });

  it('still reports a pile it could not reach as unreachable', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      droppedItems: [{ name: 'iron_ingot', at: { x: 4, y: 64, z: 0 } }],
    });
    facade.unreachable.add('4,64,0');
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/could not reach|could not pick it up/i);
    expect(result.detail).not.toMatch(/inventory is full/i);
  });
});
