/**
 * Audit of the escape reflex (src/skills/survival/escapeDanger.ts).
 *
 * The escape is the shared "get out of trouble" routine: the follow and
 * defend skills call it on every tick, before they do anything else. If it
 * picks the wrong direction the bot walks INTO the danger it is trying to
 * leave, and if it treats the wrong blocks as danger it refuses to follow a
 * player across water.
 */
import { describe, expect, it } from 'vitest';
import {
  ESCAPE_DISTANCE,
  ESCAPE_RADIUS,
  EscapeDangerSkill,
  detectDanger,
  isHostile,
  needsEscape,
} from '../../src/skills/survival/escapeDanger.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';

const LAVA = { x: -3, y: 64, z: 0 };
const ZOMBIE = { x: 1, y: 64, z: 0 };

function distance(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): number {
  return Math.hypot(from.x - to.x, from.z - to.z);
}

describe('the escape direction never points at a hazard', () => {
  it('does not run into the lava behind it because a mob pulls harder', async () => {
    // The zombie is one block away, the lava three. The zombie pulls harder
    // (1/1 block against 2/3 blocks), so the summed pull points straight at
    // the lava - the escape would walk the bot through it.
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'lava', at: LAVA }],
      entities: [{ name: 'zombie', type: 'hostile', distance: 1, position: ZOMBIE }],
    });
    const skill = new EscapeDangerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(true);
    const target = facade.moveToPositionCalls[0]?.target;
    expect(target).toBeDefined();
    // The lava is west of the bot: the escape must not end up beyond it.
    expect(target?.x ?? Number.NaN).toBeGreaterThan(LAVA.x);
    // ... and the bot must end up further from the lava than it started.
    expect(distance(facade.getPosition(), LAVA)).toBeGreaterThanOrEqual(distance({ x: 0, y: 64, z: 0 }, LAVA));
  });

  it('still runs away from a hazard that is on its own', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'lava', at: { x: 4, y: 64, z: 0 } }],
    });
    const skill = new EscapeDangerSkill(facade);
    const test = createTestContext();

    await skill.execute({}, test.ctx);

    const target = facade.moveToPositionCalls[0]?.target;
    expect(target?.x ?? Number.NaN).toBeLessThan(0);
  });

  it('escapes sideways when two hazards pull in opposite directions', async () => {
    // Lava on both sides: the pulls cancel out, so the escape used to give up
    // ("I cannot tell which way is safe") and left the bot standing in the
    // middle of the danger.
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [
        { name: 'lava', at: { x: -3, y: 64, z: 0 } },
        { name: 'lava', at: { x: 3, y: 64, z: 0 } },
      ],
    });
    const skill = new EscapeDangerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.moveToPositionCalls).toHaveLength(1);
    // Sideways is the only way out: no hazard may be closer than it was.
    expect(distance(facade.getPosition(), { x: -3, y: 64, z: 0 })).toBeGreaterThanOrEqual(3);
    expect(distance(facade.getPosition(), { x: 3, y: 64, z: 0 })).toBeGreaterThanOrEqual(3);
  });
});

describe('water is not something to run from', () => {
  it('does not treat a river as a hazard', () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'water', at: { x: 2, y: 64, z: 0 } }],
    });

    expect(needsEscape(facade, ESCAPE_RADIUS)).toBe(false);
    expect(detectDanger(facade, 6).hazardousBlocks).toHaveLength(0);
  });

  it('does not flee when the only thing nearby is water', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'water', at: { x: 2, y: 64, z: 0 } }],
    });
    const skill = new EscapeDangerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/Nothing dangerous/i);
    expect(facade.moveToPositionCalls).toHaveLength(0);
  });
});

describe('the escape uses the distance the file documents', () => {
  it('hops ESCAPE_DISTANCE blocks when the caller does not say', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'lava', at: { x: 4, y: 64, z: 0 } }],
    });
    const skill = new EscapeDangerSkill(facade);
    const test = createTestContext();

    await skill.execute({}, test.ctx);

    expect(distance(facade.getPosition(), { x: 0, y: 64, z: 0 })).toBeCloseTo(ESCAPE_DISTANCE, 5);
  });
});

describe('the behaviours the file documents are kept', () => {
  it('does not flee from the mob it is supposed to fight (hazardsOnly)', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [{ name: 'zombie', type: 'hostile', distance: 2, position: { x: 2, y: 64, z: 0 } }],
    });
    const skill = new EscapeDangerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ hazardsOnly: true }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/Nothing dangerous/i);
    expect(facade.moveToPositionCalls).toHaveLength(0);
  });

  it('does run from a mob when the caller does not limit it to hazards', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [{ name: 'zombie', type: 'hostile', distance: 2, position: { x: 2, y: 64, z: 0 } }],
    });
    const skill = new EscapeDangerSkill(facade);
    const test = createTestContext();

    await skill.execute({}, test.ctx);

    expect(facade.moveToPositionCalls).toHaveLength(1);
    expect(facade.moveToPositionCalls[0]?.target.x ?? Number.NaN).toBeLessThan(0);
  });

  it('never treats a player as a hostile mob', () => {
    expect(isHostile({ name: 'Slime', type: 'player', distance: 3, position: { x: 3, y: 64, z: 0 } })).toBe(false);
    expect(isHostile({ name: 'zombie', type: 'player', distance: 3, position: { x: 3, y: 64, z: 0 } })).toBe(false);
    expect(isHostile({ name: 'zombie', type: 'hostile', distance: 3, position: { x: 3, y: 64, z: 0 } })).toBe(true);
  });
});
