/**
 * Audit of the skill test suite and its shared fake.
 *
 * Every test here is a regression test for a defect that was found in
 * `tests/skills/` or in `tests/skills/fakes/fakeFacade.ts`. The comments name
 * the defect and the file it lived in.
 *
 * The fake-based tests (F1, F2) fail against the pre-fix fake; the rest fail
 * against the pre-fix behaviour of the skill layer - they protect the
 * invariants the broken tests only claimed to cover.
 */
import { describe, expect, it, vi } from 'vitest';
import { MOVEMENT } from '../../src/config/constants.js';
import { distance3 } from '../../src/types/world.js';
import { FollowPlayerSkill } from '../../src/skills/movement/followPlayer.js';
import { GotoPositionSkill } from '../../src/skills/movement/gotoPosition.js';
import { DefendSkill } from '../../src/skills/survival/defend.js';
import { BuildStructureSkill } from '../../src/skills/building/buildStructure.js';
import { DepositItemsSkill } from '../../src/skills/inventory/chestManager.js';
import { MineBlockSkill } from '../../src/skills/mining/mineBlock.js';
import { createSkillRegistry } from '../../src/skills/index.js';
import type { ExecutionContext } from '../../src/types/task.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';

const CHEST = { x: 2, y: 64, z: 0 };

describe('F1 - the fake must not put a deposit into a stack of another item', () => {
  it('stores dirt as dirt, and leaves the cobblestone stack alone', async () => {
    // The real facade transfers ONE itemType, so a dirt deposit can only ever
    // land in a dirt stack. The old fake topped up whatever stack had room,
    // which turned 4 of the 10 dirt into cobblestone and hid the loss.
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      inventory: { dirt: 10 },
      chests: [{ at: CHEST, items: { cobblestone: 60 } }],
    });

    const moved = await facade.depositIntoChest(CHEST, 'dirt', 10);

    expect(moved).toBe(10);
    expect(facade.chestContents(CHEST)).toEqual({ cobblestone: 60, dirt: 10 });
    // The whole deposit went into the new dirt stack.
    expect(facade.depositTrace).toEqual([10]);
    // Nothing was conjured out of thin air: the bot lost exactly what the
    // chest gained.
    expect(facade.countItem('dirt')).toBe(0);
  });

  it('still tops up an existing stack of the SAME item before opening a new one', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      inventory: { dirt: 10 },
      chests: [{ at: CHEST, items: { dirt: 60, cobblestone: 5 } }],
    });

    const moved = await facade.depositIntoChest(CHEST, 'dirt', 10);

    expect(moved).toBe(10);
    // 4 tops the dirt stack up to 64, the remaining 6 opens a new one.
    expect(facade.depositTrace).toEqual([4, 6]);
    expect(facade.chestContents(CHEST)['dirt']).toBe(70);
    // The other item is untouched.
    expect(facade.chestContents(CHEST)['cobblestone']).toBe(5);
  });
});

describe('F2 - the fake must forget a block the bot mined', () => {
  it('a block the bot dug is no longer the bot\'s own block', async () => {
    // The real facade drops the position from its own-block list after a
    // successful dig. The old fake kept it, so the fake said "this is my
    // construction" about a block that no longer existed.
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 1 } });
    const at = { x: 1, y: 64, z: 0 };

    await facade.placeBlock(at, 'cobblestone');
    expect(facade.isOwnBlock(at)).toBe(true);

    await facade.digBlock(at);
    expect(facade.isOwnBlock(at)).toBe(false);
  });
});

describe('T1 - the follow skill must never walk onto the player', () => {
  it('clamps the arrival distance to the safe minimum, whatever the model asks', async () => {
    // The old test asserted `every(arriveDistance >= 2)` over
    // `moveToPlayerCalls`, but in its scene the player stood one block away,
    // so the skill stepped back and NEVER called moveToPlayer: the
    // assertion was vacuously true and could not fail.
    //
    // The follow is given a short duration instead of an abort timer, so the
    // test never depends on the wall clock.
    for (const requested of [0, 1, 2, 5]) {
      const facade = new FakeMinecraftFacade({
        position: { x: 0, y: 64, z: 0 },
        players: [{ name: 'Alice', distance: 10, position: { x: 10, y: 64, z: 0 }, authorized: true }],
      });
      const skill = new FollowPlayerSkill(facade, 50);
      const test = createTestContext();

      await skill.execute({ player: 'Alice', distance: requested, durationMs: 120 }, test.ctx);

      // The follow really did walk to the player...
      expect(facade.moveToPlayerCalls.length).toBeGreaterThan(0);
      // ...and never asked to get closer than the safe minimum.
      for (const call of facade.moveToPlayerCalls) {
        expect(call.options?.arriveDistance ?? 0).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('steps back instead of walking into a player who is already close', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      players: [{ name: 'Alice', distance: 1, position: { x: 1, y: 64, z: 0 }, authorized: true }],
    });
    const skill = new FollowPlayerSkill(facade, 50);
    const test = createTestContext();

    await skill.execute({ player: 'Alice', distance: 0, durationMs: 120 }, test.ctx);

    // Alice is one block away: the bot must back off, not step into her.
    expect(facade.moveToPlayerCalls).toHaveLength(0);
    const alice = facade.getNearestPlayer('Alice');
    expect(distance3(facade.getPosition(), alice?.position ?? { x: 0, y: 0, z: 0 })).toBeGreaterThan(1);
  });
});

describe('T2 - a cancelled deposit must not store anything', () => {
  it('stores nothing when the task is cancelled while the bot walks to the chest', async () => {
    // The old test cancelled through a 20ms timer and relied on it landing
    // inside a 50ms fake delay. On a slow machine the transfer finished
    // first and the test failed for no reason. The abort is now fired from
    // the navigation call itself, so the outcome is exact.
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      inventory: { dirt: 10 },
      chests: [{ at: CHEST, items: {} }],
    });
    const skill = new DepositItemsSkill(facade);
    const test = createTestContext();

    const originalMove = facade.moveToPosition.bind(facade);
    facade.moveToPosition = async (target, options) => {
      test.abort();
      return originalMove(target, options);
    };

    const result = await skill.execute({ item: 'dirt' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.countItem('dirt')).toBe(10);
    expect(facade.chestContents(CHEST)['dirt']).toBeUndefined();
  });
});

describe('T3 - the guard must not spam the chat line', () => {
  it('says "can\'t see" once, however many times it ticks', async () => {
    // The old test gave the guard 700ms of real time: on a slow machine only
    // one tick happened and the chat gate was never challenged. Fake timers
    // make the tick count exact.
    vi.useFakeTimers();
    try {
      const facade = new FakeMinecraftFacade();
      const skill = new DefendSkill(facade);
      const test = createTestContext();

      const running = skill.execute({ player: 'Ghost', durationMs: 2_000 }, test.ctx);
      await vi.advanceTimersByTimeAsync(5_000);
      await running;

      const spoken = test.messages.filter((message) => message.includes("can't see"));
      expect(spoken).toHaveLength(1);
      // The guard really did tick several times, so the single message is the
      // chat gate doing its job and not an accident.
      expect(facade.stopMovingCount).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('T4 - a cancelled build must stop half way', () => {
  it('stops placing blocks as soon as the task is aborted', async () => {
    // The old test carried only 200 of the 256 blocks the platform needs, so
    // the build refused to start ("I need 256 cobblestone but I only have
    // 200") and the abort was never exercised at all.
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 300 } });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    let placements = 0;
    const ctx: ExecutionContext = {
      ...test.ctx,
      progress: (update) => {
        test.ctx.progress(update);
        placements += 1;
        if (placements === 3) test.abort();
      },
    };

    const result = await skill.execute(
      { structure: 'platform', position: { x: 0, y: 64, z: 0 }, dimensions: { length: 16, width: 16 } },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.count).toBe(3);
    // The build stopped: the other 253 cells were never touched.
    expect(facade.placedPositions).toHaveLength(3);
  });
});

describe('T5 - the registry must not share state between skills', () => {
  it('binds every registry to its own facade', async () => {
    const first = new FakeMinecraftFacade();
    const second = new FakeMinecraftFacade();

    const firstRegistry = createSkillRegistry(first);
    const secondRegistry = createSkillRegistry(second);

    // Two registries, two facades: the skills of one must not act on the
    // other (the old test file built ONE registry for the whole describe
    // block, so a skill that walked or dug leaked into the next test).
    const context = {
      task: {} as never,
      signal: new AbortController().signal,
      progress: () => undefined,
      say: () => undefined,
    };
    await firstRegistry.get('stop')?.execute({} as never, context);
    await secondRegistry.get('stop')?.execute({} as never, context);

    expect(first.stopMovingCount).toBe(1);
    expect(second.stopMovingCount).toBe(1);
  });
});

describe('T6 - walking to a position must end up AT the position', () => {
  it('asks for the exact coordinates and ends up within reach of them', async () => {
    // The old test asserted the bot stands on the exact block. The real
    // pathfinder stops `arriveDistance` short, so the contract is "the bot
    // asked for these coordinates and ended up within reach of them".
    const facade = new FakeMinecraftFacade({ position: { x: 0, y: 64, z: 0 } });
    const skill = new GotoPositionSkill(facade);
    const test = createTestContext();
    const target = { x: 8, y: 64, z: -3 };

    const result = await skill.execute({ position: target }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.moveToPositionCalls[0]?.target).toEqual(target);
    expect(distance3(facade.getPosition(), target)).toBeLessThanOrEqual(MOVEMENT.ARRIVE_DISTANCE + 1);
  });
});

describe('T7 - a cancelled mining run must stop and report what it did', () => {
  it('stops at the dig it was cancelled on, and counts exactly what it dug', async () => {
    // The old test cancelled through a 40ms timer. Depending on where the
    // timer landed, a block could be dug but NOT counted (the abort hit the
    // dig itself), and the test's own "dug == mined" assertion broke.
    // Cancelling from the walk before the fourth dig makes it exact.
    const blocks = Array.from({ length: 20 }, (_unused, index) => ({
      name: 'oak_log',
      at: { x: 2 + index, y: 64, z: 0 },
    }));
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks,
      inventory: { iron_axe: 1 },
      tools: { oak_log: 'iron_axe' },
    });
    facade.digDelayMs = 5;
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const originalMove = facade.moveToPosition.bind(facade);
    let walks = 0;
    facade.moveToPosition = async (target, options) => {
      walks += 1;
      if (walks === 4) test.abort();
      return originalMove(target, options);
    };

    const result = await skill.execute({ blockName: 'oak_log', count: 20 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.count).toBe(3);
    expect(result.remaining).toBe(17);
    // Every block the bot reports is a block it really dug.
    expect(facade.dugPositions).toHaveLength(result.count ?? 0);
  });
});
