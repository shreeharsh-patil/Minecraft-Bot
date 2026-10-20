/**
 * Audit of the eat and guard skills.
 *
 * Every test here pins down a defect that was found by reading
 * `src/skills/survival/autoEat.ts` and `src/skills/survival/defend.ts` line
 * by line. They fail against the old behaviour, so a regression that brings
 * the old behaviour back is caught here.
 */
import { describe, expect, it } from 'vitest';
import { AutoEatSkill, HUNGER_THRESHOLD } from '../../src/skills/survival/autoEat.js';
import { DefendSkill } from '../../src/skills/survival/defend.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';

describe('AutoEatSkill - the hunger threshold', () => {
  it('eats at exactly the threshold, which the skill documents as "at or below"', async () => {
    const facade = new FakeMinecraftFacade({ hunger: HUNGER_THRESHOLD, inventory: { bread: 1 } });
    const skill = new AutoEatSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.calls).toContain('eat');
    expect(facade.countItem('bread')).toBe(0);
  });

  it('does not eat above the threshold', async () => {
    const facade = new FakeMinecraftFacade({ hunger: HUNGER_THRESHOLD + 1, inventory: { bread: 1 } });
    const skill = new AutoEatSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.calls).not.toContain('eat');
    expect(facade.countItem('bread')).toBe(1);
  });
});

describe('DefendSkill - the guard really fights', () => {
  const alice = { name: 'Alice', distance: 0, position: { x: 0, y: 64, z: 0 }, authorized: true };

  it('closes the distance to a mob it cannot reach yet', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      players: [alice],
      entities: [{ name: 'zombie', type: 'hostile', distance: 5, position: { x: 5, y: 64, z: 0 }, id: 7 }],
    });
    const skill = new DefendSkill(facade);
    const test = createTestContext();

    await skill.execute({ player: 'Alice', durationMs: 300 }, test.ctx);

    // The guard walked up to the mob instead of swinging from five blocks
    // away, where the server throws the attack away.
    expect(facade.moveToPositionCalls.some((call) => call.target.x === 5)).toBe(true);
    expect(facade.getPosition().x).toBeCloseTo(5, 5);
    expect(facade.attackedIds).toContain(7);
  });

  it('does not claim a hit it could not make', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      players: [alice],
      entities: [{ name: 'zombie', type: 'hostile', distance: 5, position: { x: 5, y: 64, z: 0 }, id: 7 }],
    });
    // The mob cannot be walked up to, so it stays out of reach.
    facade.unreachable.add('5,64,0');
    const skill = new DefendSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Alice', durationMs: 300 }, test.ctx);

    expect(result.count).toBe(0);
    expect(facade.attackedIds).not.toContain(7);
  });

  it('has a sword in its hand before it hits a mob', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      inventory: { diamond_sword: 1 },
      players: [alice],
      entities: [{ name: 'zombie', type: 'hostile', distance: 2, position: { x: 2, y: 64, z: 0 }, id: 7 }],
    });
    const skill = new DefendSkill(facade);
    const test = createTestContext();

    await skill.execute({ player: 'Alice', durationMs: 300 }, test.ctx);

    // The summary carries an entity id, so the guard attacks by id - it still
    // has to hold a weapon, otherwise it fights bare-handed.
    expect(facade.attackedIds).toContain(7);
    expect(facade.equippedItems).toContain('diamond_sword');
    expect(facade.heldItem()).toBe('diamond_sword');
  });

  it('does not treat a real player as a mob to fight', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      players: [alice],
      // A player whose name looks exactly like a mob.
      entities: [{ name: 'Zombie', type: 'player', distance: 2, position: { x: 2, y: 64, z: 0 }, id: 9 }],
    });
    const skill = new DefendSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Alice', durationMs: 300 }, test.ctx);

    expect(facade.attackedIds).not.toContain(9);
    expect(result.count).toBe(0);
  });
});
