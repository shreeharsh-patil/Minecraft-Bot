/**
 * Named locations and counts.
 *
 * Two promises the bot makes to the player:
 *  - it never says it collected something "from home" when it mined it
 *    somewhere else entirely;
 *  - it never dumps a whole stack into a chest when the player asked for five
 *    items.
 */
import { describe, expect, it } from 'vitest';
import { CollectResourceSkill } from '../../src/skills/mining/collectResource.js';
import { DepositItemsSkill } from '../../src/skills/inventory/chestManager.js';
import { validateAction } from '../../src/executor/validator.js';
import { FakeMinecraftFacade } from './fakes/fakeFacade.js';
import { createTestContext } from './helpers/testContext.js';

const CHEST = { x: 2, y: 64, z: 0 };

function oreWorld(): FakeMinecraftFacade {
  return new FakeMinecraftFacade({
    inventory: { iron_axe: 1 },
    blocks: [{ name: 'iron_ore', at: { x: 3, y: 64, z: 0 } }],
    tools: { iron_ore: 'iron_axe' },
  });
}

describe('collect_resource - the named location', () => {
  it('refuses a location it does not know instead of mining elsewhere', async () => {
    const facade = oreWorld();
    const skill = new CollectResourceSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ resource: 'iron', count: 1, from: 'home' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/don't know where "home" is/i);
    // Nothing was mined, so no false claim can be made.
    expect(facade.dugPositions).toHaveLength(0);
    expect(result.count).toBe(0);
  });

  it('collects when no location is named', async () => {
    const facade = oreWorld();
    const skill = new CollectResourceSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ resource: 'iron', count: 1 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.detail).not.toMatch(/from/i);
  });
});

describe('deposit_items - count and location', () => {
  it('stores only the requested count', async () => {
    const facade = new FakeMinecraftFacade({
      inventory: { cobblestone: 64 },
      chests: [{ at: CHEST, items: {} }],
    });
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone', count: 5 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(5);
    expect(facade.countItem('cobblestone')).toBe(59);
    expect(facade.chestContents(CHEST)['cobblestone']).toBe(5);
  });

  it('refuses a location it does not know instead of using another chest', async () => {
    const facade = new FakeMinecraftFacade({
      inventory: { cobblestone: 64 },
      chests: [{ at: CHEST, items: {} }],
    });
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone', location: 'home' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/don't know where "home" is/i);
    // The chest next door stays empty.
    expect(facade.chestContents(CHEST)['cobblestone']).toBeUndefined();
    expect(facade.countItem('cobblestone')).toBe(64);
  });
});

describe('the validator keeps what the skills need', () => {
  it('keeps the count of a deposit', () => {
    const result = validateAction({ type: 'deposit_items', item: 'cobblestone', count: 5 });

    expect(result.valid).toBe(true);
    expect(result.action).toMatchObject({ type: 'deposit_items', item: 'cobblestone', count: 5 });
  });

  it('keeps the location of a deposit', () => {
    const result = validateAction({ type: 'deposit_items', item: 'cobblestone', location: 'home' });

    expect(result.valid).toBe(true);
    expect(result.action).toMatchObject({ location: 'home' });
  });

  it('keeps the location a resource is collected from', () => {
    const result = validateAction({ type: 'collect_resource', resource: 'iron', count: 1, from: 'home' });

    expect(result.valid).toBe(true);
    expect(result.action).toMatchObject({ from: 'home' });
  });
});
