/**
 * Audit of the `attack_hostile` skill.
 *
 *  - a requested mob name has to select the mob: "attack the skeleton" must
 *    not end up hitting the creeper that happens to be closer;
 *  - the bot must not swing at a mob it could not walk to: the server ignores
 *    an attack that is out of reach, so the swing never damages anything;
 *  - the mob may move (or die) while the bot walks to it, so the position
 *    the walk aimed at is stale by the time the bot swings.
 */
import { describe, expect, it, vi } from 'vitest';
import { ATTACK_DURATION_MS, AttackHostileSkill } from '../../src/skills/combat/attackHostile.js';
import type { EntitySummary } from '../../src/types/world.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';

/** Runs the skill for a moment, then stops it. */
async function runBriefly(
  skill: AttackHostileSkill,
  params: Parameters<AttackHostileSkill['execute']>[0],
): Promise<{ count: number; ok: boolean; detail?: string }> {
  const test = createTestContext();
  const running = skill.execute(params, test.ctx);
  await new Promise((resolve) => setTimeout(resolve, 120));
  test.abort();
  const result = await running;
  return { count: result.count ?? 0, ok: result.ok, detail: result.detail };
}

describe('attack_hostile - the mob that was asked for', () => {
  it('fights the requested mob, not the nearest hostile', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [
        { name: 'creeper', type: 'hostile', distance: 2, position: { x: 2, y: 64, z: 0 }, id: 11 },
        { name: 'skeleton', type: 'hostile', distance: 6, position: { x: 6, y: 64, z: 0 }, id: 22 },
      ],
    });
    const skill = new AttackHostileSkill(facade);

    await runBriefly(skill, { target: 'skeleton' });

    // The creeper was closer, but the request named the skeleton.
    expect(facade.attackedIds).not.toContain(11);
    expect(facade.attackedIds).toContain(22);
  });

  it('reports that the named mob is not there instead of hitting another one', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [{ name: 'creeper', type: 'hostile', distance: 2, position: { x: 2, y: 64, z: 0 }, id: 11 }],
    });
    const skill = new AttackHostileSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ target: 'skeleton' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/skeleton/i);
    expect(facade.attackedIds).toEqual([]);
    expect(facade.calls).not.toContain('useItem');
  });

  it('understands the plural the model asks in', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [{ name: 'zombie', type: 'hostile', distance: 2, position: { x: 2, y: 64, z: 0 }, id: 12 }],
    });
    const skill = new AttackHostileSkill(facade);

    await runBriefly(skill, { target: 'Zombies' });

    expect(facade.attackedIds).toContain(12);
  });

  it('does not mistake one family for another', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [
        { name: 'zombie', type: 'hostile', distance: 2, position: { x: 2, y: 64, z: 0 }, id: 13 },
        { name: 'zombie_villager', type: 'hostile', distance: 3, position: { x: 3, y: 64, z: 0 }, id: 14 },
      ],
    });
    const skill = new AttackHostileSkill(facade);

    await runBriefly(skill, { target: 'zombie' });

    expect(facade.attackedIds).toContain(13);
    expect(facade.attackedIds).not.toContain(14);
  });
});

describe('attack_hostile - a mob out of reach', () => {
  it('does not swing at a mob it could not walk to', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [{ name: 'zombie', type: 'hostile', distance: 10, position: { x: 10, y: 64, z: 0 }, id: 33 }],
    });
    // The walk fails, so the zombie is still ten blocks away.
    facade.pathfindingFails = true;
    const skill = new AttackHostileSkill(facade);

    const result = await runBriefly(skill, {});

    // An attack that far out is ignored by the server: it never damages
    // the mob, so it must not be reported as a hit either.
    expect(facade.attackedIds).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.ok).toBe(false);
  });

  it('reports that it could not reach the mob instead of claiming a fight', async () => {
    vi.useFakeTimers();
    try {
      const facade = new FakeMinecraftFacade({
        position: { x: 0, y: 64, z: 0 },
        entities: [{ name: 'zombie', type: 'hostile', distance: 10, position: { x: 10, y: 64, z: 0 }, id: 34 }],
      });
      facade.pathfindingFails = true;
      const skill = new AttackHostileSkill(facade);
      const test = createTestContext();

      const running = skill.execute({}, test.ctx);
      await vi.advanceTimersByTimeAsync(ATTACK_DURATION_MS + 1_000);
      const result = await running;

      expect(result.ok).toBe(false);
      expect(result.count).toBe(0);
      expect(result.detail).toMatch(/could not reach/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('attack_hostile - the mob moves or dies while the bot walks', () => {
  it('does not swing at a mob that died during the walk', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [{ name: 'zombie', type: 'hostile', distance: 10, position: { x: 10, y: 64, z: 0 }, id: 44 }],
    });
    const originalMove = facade.moveToPosition.bind(facade);
    facade.moveToPosition = async (target, options) => {
      const result = await originalMove(target, options);
      // The mob is killed while the bot is walking towards it.
      facade.removeEntity('zombie');
      return result;
    };
    const skill = new AttackHostileSkill(facade);

    const result = await runBriefly(skill, {});

    expect(facade.attackedIds).toEqual([]);
    expect(result.count).toBe(0);
    // The mob is gone, not merely out of reach.
    expect(result.detail).toMatch(/is gone/i);
  });

  it('keeps fighting the same mob (by id) even when a closer one appears', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [{ name: 'zombie', type: 'hostile', distance: 5, position: { x: 5, y: 64, z: 0 }, id: 55 }],
    });
    const originalMove = facade.moveToPosition.bind(facade);
    facade.moveToPosition = async (target, options) => {
      const result = await originalMove(target, options);
      // A second zombie turns up, closer than the one being fought.
      const entities = (facade as unknown as { entities: EntitySummary[] }).entities;
      entities.push({ name: 'zombie', type: 'hostile', distance: 1, position: { x: 1, y: 64, z: 0 }, id: 66 });
      return result;
    };
    const skill = new AttackHostileSkill(facade);

    await runBriefly(skill, {});

    expect(facade.attackedIds).toContain(55);
    expect(facade.attackedIds).not.toContain(66);
  });

  it('chases the mob to where it moved instead of swinging at the old spot', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [{ name: 'zombie', type: 'hostile', distance: 4, position: { x: 4, y: 64, z: 0 } }],
    });
    const originalMove = facade.moveToPosition.bind(facade);
    let first = true;
    facade.moveToPosition = async (target, options) => {
      const result = await originalMove(target, options);
      if (first) {
        first = false;
        // The mob walks off while the bot is walking towards it.
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

    // The bot followed the mob to its new spot...
    expect(facade.moveToPositionCalls.some((call) => call.target.x === 12)).toBe(true);
    // ...and it never swung at the block the mob had left behind.
    expect(facade.lookTargets.every((target) => target.x !== 4)).toBe(true);
  });
});
