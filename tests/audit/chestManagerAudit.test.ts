/**
 * Audit regressions for the chest skills (`deposit_items` / `withdraw_items`).
 *
 * Each test here fails against the unfixed skill:
 *  - a withdrawal must never ask the chest for more items than the inventory
 *    can hold (mineflayer moves what fits, then throws, and the facade reports
 *    that as "nothing moved");
 *  - a transfer that stops early must say how much is left;
 *  - a request that cannot be honoured must be refused BEFORE the bot walks to
 *    a chest it is not going to use;
 *  - the shared deposit helper must refuse a nonsense count itself.
 */
import { describe, expect, it } from 'vitest';
import {
  DepositItemsSkill,
  WithdrawItemsSkill,
  transferIntoChest,
} from '../../src/skills/inventory/chestManager.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import type { FakeWorldInit } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';
import type { BlockPos } from '../../src/types/world.js';

const CHEST = { x: 2, y: 64, z: 0 };
/** A full inventory stack holds this many items. */
const MAX_STACK = 64;

function worldWithChest(
  inventory: Record<string, number>,
  chestItems: Record<string, number> = {},
): FakeMinecraftFacade {
  return new FakeMinecraftFacade({
    position: { x: 0, y: 64, z: 0 },
    inventory,
    chests: [{ at: CHEST, items: chestItems }],
  });
}

/** An inventory that leaves only `free` of the 36 slots empty. */
function nearlyFullInventory(free: number): Record<string, number> {
  const items: Record<string, number> = {};
  for (let i = 0; i < 36 - free; i += 1) items[`filler_${i}`] = 1;
  return items;
}

/**
 * A chest facade that behaves like the REAL one when the inventory runs out
 * of room.
 *
 * mineflayer's `bot.transfer` moves items until the destination is full and
 * then throws "destination full"
 * (node_modules/mineflayer/lib/plugins/inventory.js). The real facade
 * swallows that throw and reports 0, so the skill never learns that items
 * really did move.
 */
class StrictChestFacade extends FakeMinecraftFacade {
  /** Chest contents, kept here so the class can write to them. */
  private readonly contents = new Map<string, number>();

  public constructor(init: FakeWorldInit, private readonly free: number) {
    super(init);
    for (const chest of init.chests ?? []) {
      for (const [item, count] of Object.entries(chest.items ?? {})) {
        this.contents.set(`${item}@${chest.at.x},${chest.at.y},${chest.at.z}`, count);
      }
    }
  }

  public override freeSlots(): number | null {
    return this.free;
  }

  public override withdrawFromChest(chest: BlockPos, item: string, count: number): Promise<number> {
    const key = `${item}@${chest.x},${chest.y},${chest.z}`;
    const have = this.contents.get(key) ?? 0;
    if (have <= 0) return Promise.resolve(0);
    const capacity = this.free * MAX_STACK;
    if (count > capacity) {
      // mineflayer moves what fits and then throws; the facade reports 0.
      this.contents.set(key, have - capacity);
      this.addItem(item, capacity);
      return Promise.resolve(0);
    }
    const moved = Math.min(count, have);
    this.contents.set(key, have - moved);
    this.addItem(item, moved);
    return Promise.resolve(moved);
  }
}

describe('withdraw_items - the request must fit the inventory', () => {
  it('never asks the chest for more items than the free slots can hold', async () => {
    const facade = worldWithChest(nearlyFullInventory(2), { cobblestone: 500 });
    const requested: number[] = [];
    const original = facade.withdrawFromChest.bind(facade);
    facade.withdrawFromChest = (chest, item, count) => {
      requested.push(count);
      return original(chest, item, count);
    };
    const skill = new WithdrawItemsSkill(facade);
    const test = createTestContext();

    const free = facade.freeSlots() ?? 0;
    const result = await skill.execute({ item: 'cobblestone', count: 500 }, test.ctx);

    expect(free).toBe(2);
    expect(requested[0]).toBeLessThanOrEqual(free * MAX_STACK);
    expect(result.count).toBeLessThanOrEqual(free * MAX_STACK);
  });

  it('reports the withdrawal truthfully when the request does not fit', async () => {
    const facade = new StrictChestFacade(
      { position: { x: 0, y: 64, z: 0 }, chests: [{ at: CHEST, items: { cobblestone: 500 } }] },
      2,
    );
    const skill = new WithdrawItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone', count: 500 }, test.ctx);

    // The chest is NOT empty, so claiming it is would be a lie - and the 128
    // items that fitted have to be counted.
    expect(result.detail).not.toMatch(/no cobblestone in that chest/i);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(128);
    expect(facade.countItem('cobblestone')).toBe(128);
  });
});

describe('withdraw_items - a transfer that stops early says what is left', () => {
  it('reports the shortfall when the chest holds less than was asked for', async () => {
    const facade = worldWithChest({}, { cobblestone: 10 });
    const skill = new WithdrawItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone', count: 20 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(10);
    expect(result.remaining).toBe(10);
    expect(result.detail).toMatch(/of 20/);
  });
});

describe('deposit_items - a transfer that stops early says what is left', () => {
  it('reports the remainder when the chest cannot take everything', async () => {
    const facade = worldWithChest({ dirt: 100 });
    facade.chestCapacity = 30;
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'dirt', count: 100 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(30);
    expect(result.remaining).toBe(70);
  });

  it('reports the remainder when the chest takes nothing at all', async () => {
    const facade = worldWithChest({ dirt: 40 });
    facade.chestCapacity = 0;
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'dirt', count: 40 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.count).toBe(0);
    expect(result.remaining).toBe(40);
  });
});

describe('withdraw_items - an impossible request is refused before the walk', () => {
  it('does not walk to the chest for a count of zero', async () => {
    const facade = worldWithChest({}, { cobblestone: 8 });
    const skill = new WithdrawItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone', count: 0 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/count of at least 1/i);
    expect(facade.moveToPositionCalls).toHaveLength(0);
  });

  it('does not walk to the chest when the inventory is already full', async () => {
    const facade = worldWithChest({ dirt: 5 }, { cobblestone: 64 });
    facade.inventoryFull = true;
    const skill = new WithdrawItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: 'cobblestone', count: 10 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/inventory is full/i);
    expect(facade.moveToPositionCalls).toHaveLength(0);
    expect(facade.chestContents(CHEST)['cobblestone']).toBe(64);
  });
});

describe('transferIntoChest - the helper guards its own count', () => {
  it('refuses a count of zero without touching the chest', async () => {
    const facade = worldWithChest({ dirt: 10 });
    const test = createTestContext();

    const result = await transferIntoChest(facade, test.ctx, { item: 'dirt', count: 0 });

    expect(result.ok).toBe(false);
    expect(facade.calls).not.toContain('depositIntoChest:dirt');
  });

  it('stores whole items only', async () => {
    const facade = worldWithChest({ dirt: 10 });
    const test = createTestContext();

    const result = await transferIntoChest(facade, test.ctx, { item: 'dirt', count: 2.5 });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(facade.countItem('dirt')).toBe(8);
  });
});
