/**
 * Audit regression tests for `pickup_items` (src/skills/inventory/pickupItems.ts).
 *
 * The shared fake facade hands a stack over *synchronously* inside
 * `moveToPosition`. The real server does not: Minecraft applies a pickup on
 * its next tick, so the stack is still missing from the inventory when the
 * walk resolves. `ServerTickFacade` reproduces that, which is what the
 * pickup timing depends on.
 */
import { describe, expect, it } from 'vitest';
import { PickupItemsSkill } from '../../src/skills/inventory/pickupItems.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';
import { distance3 } from '../../src/types/world.js';
import type { MoveResult, NavigationOptions, Vec3Like } from '../../src/types/facade.js';

/** How close the bot must be before the server hands a stack over. */
const PICKUP_RADIUS = 1;

/**
 * A facade that applies the pickup on the server's next tick: the walk
 * resolves first, the stack lands in the inventory a moment later.
 */
class ServerTickFacade extends FakeMinecraftFacade {
  /** How long the server takes to hand the stack over. */
  public handOverDelayMs = 10;

  public override moveToPosition(
    target: Vec3Like,
    options?: NavigationOptions,
  ): Promise<MoveResult> {
    this.calls.push('moveToPosition');
    this.moveToPositionCalls.push({ target: { ...target }, ...(options ? { options } : {}) });
    if (options?.signal?.aborted) return Promise.resolve({ status: 'cancelled' });
    if (this.pathfindingFails || this.unreachable.has(`${target.x},${target.y},${target.z}`)) {
      return Promise.resolve({ status: 'unreachable', reason: 'no path' });
    }
    this.setPosition(target);
    // The stacks within reach right now are handed over one tick later.
    const pending = this.droppedItemPositions().filter(
      (at) => distance3(this.getPosition(), at) <= PICKUP_RADIUS,
    );
    const timer = setTimeout(() => {
      for (const at of pending) {
        this.removeDroppedItem(at);
        this.addItem('iron_ingot', 1);
        this.pickedUp.push({ item: 'iron_ingot', count: 1 });
      }
    }, this.handOverDelayMs);
    timer.unref();
    return Promise.resolve({ status: 'arrived', distance: 0 });
  }
}

describe('PickupItemsSkill audit - pickup timing', () => {
  it('counts a stack the server hands over a tick after the walk', async () => {
    const facade = new ServerTickFacade({
      droppedItems: [{ name: 'iron_ingot', at: { x: 2, y: 64, z: 0 } }],
    });
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    // Without a grace window the stack is still on the server when the
    // inventory is read, so the pile looks like a failure and is never
    // counted - even though the bot ends up holding it.
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(facade.countItem('iron_ingot')).toBe(1);
  });

  it('satisfies a requested count with a stack handed over one tick later', async () => {
    const facade = new ServerTickFacade({
      droppedItems: [{ name: 'iron_ingot', at: { x: 2, y: 64, z: 0 } }],
    });
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ count: 1 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.remaining).toBeUndefined();
  });

  it('does not blame the walk for three stacks the server hands over late', async () => {
    const facade = new ServerTickFacade({
      droppedItems: [
        { name: 'iron_ingot', at: { x: 2, y: 64, z: 0 } },
        { name: 'iron_ingot', at: { x: 5, y: 64, z: 0 } },
        { name: 'iron_ingot', at: { x: 8, y: 64, z: 0 } },
      ],
    });
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    // Every pile looked like a failed walk, so the skill gave up with a
    // navigation failure while the bot collected all three stacks.
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
    expect(result.detail).not.toMatch(/could not reach/i);
  });

  it('still reports a pile it never reached as unreachable', async () => {
    const facade = new FakeMinecraftFacade({
      droppedItems: [
        { name: 'iron_ingot', at: { x: 2, y: 64, z: 0 } },
        { name: 'iron_ingot', at: { x: 5, y: 64, z: 0 } },
        { name: 'iron_ingot', at: { x: 8, y: 64, z: 0 } },
      ],
    });
    for (const at of ['2,64,0', '5,64,0', '8,64,0']) facade.unreachable.add(at);
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/could not reach/i);
  });

  it('does not blame the walk for a pile it reached that never came in', async () => {
    const facade = new ServerTickFacade({
      droppedItems: [
        { name: 'iron_ingot', at: { x: 2, y: 64, z: 0 } },
        { name: 'iron_ingot', at: { x: 5, y: 64, z: 0 } },
        { name: 'iron_ingot', at: { x: 8, y: 64, z: 0 } },
      ],
    });
    // The server never hands these over: the bot stands on them and nothing
    // arrives.
    facade.handOverDelayMs = 60_000;
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).not.toMatch(/could not reach/i);
    expect(result.detail).toMatch(/never came into my inventory/i);
  });

  it('stops promptly when the task is cancelled while waiting for a hand-over', async () => {
    const facade = new ServerTickFacade({
      droppedItems: [{ name: 'iron_ingot', at: { x: 2, y: 64, z: 0 } }],
    });
    facade.handOverDelayMs = 60_000;
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const started = Date.now();
    const running = skill.execute({}, test.ctx);
    setTimeout(() => test.abort(), 50);
    const result = await running;

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Stopped collecting/i);
    // The grace window must not hold the task hostage.
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

describe('PickupItemsSkill audit - reporting', () => {
  it('says that stacks are still on the ground when the attempt ceiling stops the run', async () => {
    const droppedItems = [];
    for (let i = 0; i < 30; i += 1) {
      droppedItems.push({ name: 'iron_ingot', at: { x: i * 3 + 1, y: 64, z: 0 } });
    }
    const facade = new FakeMinecraftFacade({ droppedItems });
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    // The ceiling stopped the run with six stacks still lying there; a plain
    // "Picked up 24 items." claims the job was done.
    expect(result.ok).toBe(true);
    expect(result.count).toBe(24);
    expect(facade.droppedItemPositions()).toHaveLength(6);
    expect(result.detail).toMatch(/still on the ground/i);
  });

  it('does not claim a shortfall when the requested count was met', async () => {
    const droppedItems = [];
    for (let i = 0; i < 30; i += 1) {
      droppedItems.push({ name: 'iron_ingot', at: { x: i * 3 + 1, y: 64, z: 0 } });
    }
    const facade = new FakeMinecraftFacade({ droppedItems });
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ count: 5 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(5);
    expect(result.detail).not.toMatch(/still on the ground/i);
  });
});

describe('PickupItemsSkill audit - parameters', () => {
  it('refuses a count of zero instead of collecting one item', async () => {
    const facade = new FakeMinecraftFacade({
      droppedItems: [{ name: 'iron_ingot', at: { x: 2, y: 64, z: 0 } }],
    });
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ count: 0 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/at least 1/i);
    expect(facade.countItem('iron_ingot')).toBe(0);
    expect(facade.droppedItemPositions()).toHaveLength(1);
  });

  it('refuses an item name that is not an item name', async () => {
    const facade = new FakeMinecraftFacade({
      droppedItems: [{ name: 'iron_ingot', at: { x: 2, y: 64, z: 0 } }],
    });
    const skill = new PickupItemsSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ item: '!!!' }, test.ctx);

    // A name that normalises to nothing must never fall back to "collect
    // everything".
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/valid item name/i);
    expect(facade.countItem('iron_ingot')).toBe(0);
    expect(facade.droppedItemPositions()).toHaveLength(1);
  });
});
