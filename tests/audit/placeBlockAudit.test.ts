/**
 * Audit of the `place_block` skill.
 *
 * Three defects, each with a regression test that fails without the fix:
 *
 *  1. the bot could build into its own body. "Place a block here" points at
 *     the cell the bot is standing in, and the entity scan can never see
 *     the bot: the facade leaves the bot out of its own entity list.
 *  2. the entity scan is centred on the bot, so a player standing in a cell
 *     the bot had not walked to yet was never seen - the bot walked over and
 *     built the block inside them.
 *  3. the target cell was checked before the bot walked over and never
 *     checked again, so somebody who stepped into the cell during the walk
 *     got a block materialised inside them.
 */
import { describe, expect, it } from 'vitest';
import { PlaceBlockSkill } from '../../src/skills/building/placeBlock.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';
import type { MoveResult, NavigationOptions } from '../../src/types/facade.js';
import type { Vec3Like } from '../../src/types/world.js';
import { distance3 } from '../../src/types/world.js';

/**
 * The real facade reports "arrived" WITHOUT moving when the bot is already
 * within the arrive distance of the goal. The shared fake always walks, so
 * this double reproduces the real behaviour: the bot can still be standing
 * in the cell it was asked to build in.
 */
class StickyFacade extends FakeMinecraftFacade {
  public override async moveToPosition(
    target: Vec3Like,
    options?: NavigationOptions,
  ): Promise<MoveResult> {
    const arrive = options?.arriveDistance ?? 1.5;
    if (distance3(this.getPosition(), target) <= arrive) {
      return { status: 'arrived', distance: 0 };
    }
    return super.moveToPosition(target, options);
  }
}

/** A bot that cannot step off the cell it is standing in. */
class NoStepAsideFacade extends StickyFacade {
  public override async moveToPosition(
    target: Vec3Like,
    options?: NavigationOptions,
  ): Promise<MoveResult> {
    if (options?.arriveDistance === 0) {
      return { status: 'unreachable', reason: 'nowhere to step' };
    }
    return super.moveToPosition(target, options);
  }
}

/** A mob that walks into the target cell while the bot is on its way. */
class MobWalksInFacade extends FakeMinecraftFacade {
  /** Where the mob walks to, once the bot has moved. */
  public walkTarget: Vec3Like | null = null;

  public override async moveToPosition(
    target: Vec3Like,
    options?: NavigationOptions,
  ): Promise<MoveResult> {
    const result = await super.moveToPosition(target, options);
    if (this.walkTarget !== null) {
      this.moveEntity('Zombie', this.walkTarget);
    }
    return result;
  }
}

function cellOf(position: Vec3Like): Vec3Like {
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
}

describe('place_block - the bot must not build into itself', () => {
  it('steps aside instead of placing a block in the cell it stands in', async () => {
    const facade = new StickyFacade({
      inventory: { cobblestone: 5 },
      position: { x: 0, y: 64, z: 0 },
    });
    const skill = new PlaceBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { blockName: 'cobblestone', position: { x: 0, y: 64, z: 0 } },
      test.ctx,
    );

    expect(result.ok).toBe(true);
    // The block lands where the bot was asked to put it...
    expect(facade.getBlockAt({ x: 0, y: 64, z: 0 })).toBe('cobblestone');
    // ...but the bot is no longer inside it.
    expect(cellOf(facade.getPosition())).not.toEqual({ x: 0, y: 64, z: 0 });
  });

  it('refuses to build when it cannot step off the cell', async () => {
    const facade = new NoStepAsideFacade({
      inventory: { cobblestone: 5 },
      position: { x: 0, y: 64, z: 0 },
    });
    const skill = new PlaceBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { blockName: 'cobblestone', position: { x: 0, y: 64, z: 0 } },
      test.ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/standing in that spot/i);
    expect(facade.placedPositions).toHaveLength(0);
    expect(facade.getBlockAt({ x: 0, y: 64, z: 0 })).toBe('air');
  });
});

describe('place_block - the entity scan has to reach the target', () => {
  it('sees a player standing in a cell further away than the default radius', async () => {
    const facade = new FakeMinecraftFacade({
      inventory: { cobblestone: 5 },
      position: { x: 0, y: 64, z: 0 },
      entities: [
        { name: 'Alice', type: 'player', distance: 20, position: { x: 20, y: 64, z: 0 } },
      ],
    });
    const skill = new PlaceBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { blockName: 'cobblestone', position: { x: 20, y: 64, z: 0 } },
      test.ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/standing there/i);
    // The bot must not walk over to a cell somebody is standing in.
    expect(facade.moveToPositionCalls).toHaveLength(0);
    expect(facade.placedPositions).toHaveLength(0);
  });
});

describe('place_block - the cell is checked again after the walk', () => {
  it('refuses when a mob walks into the cell while the bot is on its way', async () => {
    const facade = new MobWalksInFacade({
      inventory: { cobblestone: 5 },
      position: { x: 0, y: 64, z: 0 },
      entities: [
        { name: 'Zombie', type: 'hostile', distance: 3, position: { x: 3, y: 64, z: 0 } },
      ],
    });
    facade.walkTarget = { x: 10, y: 64, z: 0 };
    const skill = new PlaceBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { blockName: 'cobblestone', position: { x: 10, y: 64, z: 0 } },
      test.ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/standing there/i);
    expect(facade.placedPositions).toHaveLength(0);
    expect(facade.getBlockAt({ x: 10, y: 64, z: 0 })).toBe('air');
  });
});
