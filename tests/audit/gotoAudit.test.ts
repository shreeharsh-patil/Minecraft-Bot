/**
 * Audit of the two movement skills (`gotoPlayer.ts`, `gotoPosition.ts`).
 *
 * The regression tests are the ones that fail without the fix:
 *  1. the skills walked the bot into a hazard cell - lava, fire and the rest
 *     of the danger list are blocks the bot is never supposed to stand in,
 *     and the `avoid` list the navigation helper passes only governs the
 *     route, not the destination;
 *  2. a failing world query (where am I, where is the player) escaped the
 *     skill as a raw exception instead of being reported as a result. The
 *     navigation call itself is already guarded by the shared helper, so the
 *     tests below also pin that it keeps being reported as a failure.
 *
 * The remaining tests lock in the behaviour the audit verified as correct
 * (the arrival check, the walk target, the abort path and the cancellation
 * path) so a later change cannot quietly invert or drop them.
 */
import { describe, expect, it } from 'vitest';
import { GotoPlayerSkill } from '../../src/skills/movement/gotoPlayer.js';
import { GotoPositionSkill } from '../../src/skills/movement/gotoPosition.js';
import type { MoveResult } from '../../src/types/facade.js';
import type { PlayerSummary, Vec3Like } from '../../src/types/world.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';

function worldWithAlice(
  aliceAt = { x: 10, y: 64, z: 0 },
  blocks: Array<{ name: string; at: { x: number; y: number; z: number } }> = [],
): FakeMinecraftFacade {
  return new FakeMinecraftFacade({
    position: { x: 0, y: 64, z: 0 },
    players: [{ name: 'Alice', distance: 10, position: aliceAt, authorized: true }],
    blocks,
  });
}

/** A facade whose navigation blows up instead of walking. */
class ExplodingFacade extends FakeMinecraftFacade {
  public override moveToPosition(): Promise<MoveResult> {
    throw new Error('the pathfinder exploded');
  }

  public override moveToPlayer(): Promise<MoveResult> {
    throw new Error('the pathfinder exploded');
  }
}

/**
 * A facade whose WORLD QUERY blows up.
 *
 * The navigation call is already guarded by the shared helper, but the world
 * queries around it (where is the player, where am I) are not: a failure there
 * used to escape the skill as a raw exception.
 */
class ExplodingWorldFacade extends FakeMinecraftFacade {
  public override getNearestPlayer(): PlayerSummary | null {
    throw new Error('the entity table exploded');
  }

  public override getPosition(): Vec3Like {
    throw new Error('the entity table exploded');
  }
}

describe('gotoPosition - the bot must not walk into a hazard', () => {
  it('refuses a destination that holds lava', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'lava', at: { x: 10, y: 64, z: 0 } }],
    });
    const skill = new GotoPositionSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ position: { x: 10, y: 64, z: 0 } }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/lava/i);
    // The walk never started: nothing was asked of the pathfinder.
    expect(facade.moveToPositionCalls).toHaveLength(0);
    expect(facade.getPosition()).toEqual({ x: 0, y: 64, z: 0 });
  });

  it('refuses a destination that holds fire', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'fire', at: { x: 4, y: 64, z: 0 } }],
    });
    const skill = new GotoPositionSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ position: { x: 4, y: 64, z: 0 } }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/fire/i);
    expect(facade.moveToPositionCalls).toHaveLength(0);
  });

  it('still walks to a harmless spot next to the hazard', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'lava', at: { x: 10, y: 64, z: 0 } }],
    });
    const skill = new GotoPositionSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ position: { x: 10, y: 64, z: 2 } }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.moveToPositionCalls).toHaveLength(1);
  });
});

describe('gotoPlayer - the bot must not walk into a hazard', () => {
  it('refuses to walk into the cell the player is standing in', async () => {
    const facade = worldWithAlice({ x: 10, y: 64, z: 0 }, [
      { name: 'fire', at: { x: 10, y: 64, z: 0 } },
    ]);
    const skill = new GotoPlayerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Alice' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/fire/i);
    expect(facade.moveToPlayerCalls).toHaveLength(0);
  });

  it('still walks to a player standing on ordinary ground', async () => {
    const facade = worldWithAlice();
    const skill = new GotoPlayerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Alice' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.moveToPlayerCalls).toHaveLength(1);
  });
});

describe('the movement skills report failures instead of throwing', () => {
  it('gotoPosition turns a broken world query into a failed result', async () => {
    const facade = new ExplodingWorldFacade({ position: { x: 0, y: 64, z: 0 } });
    const skill = new GotoPositionSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ position: { x: 10, y: 64, z: 0 } }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/failed/i);
  });

  it('gotoPlayer turns a broken world query into a failed result', async () => {
    const facade = new ExplodingWorldFacade({
      position: { x: 0, y: 64, z: 0 },
      players: [{ name: 'Alice', distance: 10, position: { x: 10, y: 64, z: 0 }, authorized: true }],
    });
    const skill = new GotoPlayerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Alice' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/failed/i);
  });

  it('gotoPosition turns a broken pathfinder into a failed result', async () => {
    const facade = new ExplodingFacade({ position: { x: 0, y: 64, z: 0 } });
    const skill = new GotoPositionSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ position: { x: 10, y: 64, z: 0 } }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/failed/i);
  });

  it('gotoPlayer turns a broken pathfinder into a failed result', async () => {
    const facade = new ExplodingFacade({
      position: { x: 0, y: 64, z: 0 },
      players: [{ name: 'Alice', distance: 10, position: { x: 10, y: 64, z: 0 }, authorized: true }],
    });
    const skill = new GotoPlayerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Alice' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/failed/i);
  });
});

describe('gotoPosition - the arrival check and the walk target', () => {
  it('asks for exactly the coordinates it was given', async () => {
    const facade = new FakeMinecraftFacade({ position: { x: 0, y: 64, z: 0 } });
    const skill = new GotoPositionSkill(facade);
    const test = createTestContext();
    const target = { x: 8, y: 64, z: -3 };

    const result = await skill.execute({ position: target }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.moveToPositionCalls[0]?.target).toEqual(target);
  });

  it('does not walk when it is already there', async () => {
    const facade = new FakeMinecraftFacade({ position: { x: 0, y: 64, z: 0 } });
    const skill = new GotoPositionSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ position: { x: 1, y: 64, z: 0 } }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/already there/i);
    expect(facade.moveToPositionCalls).toHaveLength(0);
  });

  it('rejects coordinates that are not numbers', async () => {
    const facade = new FakeMinecraftFacade({ position: { x: 0, y: 64, z: 0 } });
    const skill = new GotoPositionSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ position: { x: Number.NaN, y: 64, z: 0 } }, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.moveToPositionCalls).toHaveLength(0);
  });

  it('does not move at all when the task was cancelled before it started', async () => {
    const facade = new FakeMinecraftFacade({ position: { x: 0, y: 64, z: 0 } });
    const skill = new GotoPositionSkill(facade);
    const test = createTestContext();
    test.abort();

    const result = await skill.execute({ position: { x: 10, y: 64, z: 0 } }, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.moveToPositionCalls).toHaveLength(0);
  });

  it('reports the cancellation when the walk is aborted half way', async () => {
    const facade = new FakeMinecraftFacade({ position: { x: 0, y: 64, z: 0 } });
    facade.moveDelayMs = 200;
    const skill = new GotoPositionSkill(facade);
    const test = createTestContext();

    const running = skill.execute({ position: { x: 10, y: 64, z: 0 } }, test.ctx);
    setTimeout(() => test.abort(), 30);
    const result = await running;

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/stopped while walking/i);
  });
});

describe('gotoPlayer - the arrival check and the walk target', () => {
  it('does not walk when the player is already next to the bot', async () => {
    const facade = worldWithAlice({ x: 1, y: 64, z: 0 });
    const skill = new GotoPlayerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Alice' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/already next to/i);
    expect(facade.moveToPlayerCalls).toHaveLength(0);
  });

  it('reports an unknown player without moving', async () => {
    const facade = worldWithAlice();
    const skill = new GotoPlayerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Nobody' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/can't find Nobody/i);
    expect(facade.moveToPlayerCalls).toHaveLength(0);
  });

  it('does not move at all when the task was cancelled before it started', async () => {
    const facade = worldWithAlice();
    const skill = new GotoPlayerSkill(facade);
    const test = createTestContext();
    test.abort();

    const result = await skill.execute({ player: 'Alice' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.moveToPlayerCalls).toHaveLength(0);
  });

  it('reports the cancellation when the walk is aborted half way', async () => {
    const facade = worldWithAlice();
    facade.moveDelayMs = 200;
    const skill = new GotoPlayerSkill(facade);
    const test = createTestContext();

    const running = skill.execute({ player: 'Alice' }, test.ctx);
    setTimeout(() => test.abort(), 30);
    const result = await running;

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/stopped while walking/i);
  });

  it('walks to the player and stops short of them', async () => {
    const facade = worldWithAlice();
    const skill = new GotoPlayerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Alice' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.moveToPlayerCalls).toHaveLength(1);
    expect(facade.getPosition().x).toBeGreaterThan(7);
    expect(facade.getPosition().x).toBeLessThan(10);
  });
});
