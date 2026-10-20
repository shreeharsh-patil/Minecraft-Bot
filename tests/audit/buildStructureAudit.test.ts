/**
 * Audit regression tests for `src/skills/building/buildStructure.ts`.
 *
 * Every case below fails without the matching fix in buildStructure.ts:
 *  - the doorway of a simple house is an offset from the origin, so a house
 *    that is not built at x = 0 must still have a door;
 *  - a structure that does not fit into the block cap is shrunk, never cut
 *    short: a house without a roof is not a house;
 *  - a run that cannot place anything gives up instead of hammering every
 *    single cell of the plan.
 */
import { describe, expect, it } from 'vitest';
import {
  BuildStructureSkill,
  MAX_BUILD_BLOCKS,
  planStructure,
} from '../../src/skills/building/buildStructure.js';
import type { BlockPos } from '../../src/types/world.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';

const key = (p: BlockPos): string => `${p.x},${p.y},${p.z}`;

/** A facade whose placements always fail - the bot can never build anything. */
class FailingFacade extends FakeMinecraftFacade {
  public attempts = 0;

  public override placeBlock(position: BlockPos, blockName: string): Promise<boolean> {
    this.attempts += 1;
    this.calls.push(`placeBlock:${blockName}@${position.x}`);
    return Promise.resolve(false);
  }
}

describe('build_structure audit - the doorway', () => {
  it('opens the doorway of a house that is not built at x = 0', () => {
    const origin = { x: 120, y: 64, z: -35 };
    const plan = planStructure('simple_house', origin, { size: 5, height: 4 });
    const planned = new Set(plan.map(key));

    // The middle of the far wall is the doorway: it must stay empty.
    expect(planned.has(key({ x: origin.x + 2, y: origin.y + 1, z: origin.z + 4 }))).toBe(false);
    expect(planned.has(key({ x: origin.x + 2, y: origin.y + 2, z: origin.z + 4 }))).toBe(false);
    // The wall either side of the doorway is solid.
    expect(planned.has(key({ x: origin.x + 1, y: origin.y + 1, z: origin.z + 4 }))).toBe(true);
    expect(planned.has(key({ x: origin.x + 3, y: origin.y + 1, z: origin.z + 4 }))).toBe(true);
  });

  it('opens the doorway of a house at a negative origin too', () => {
    const origin = { x: -200, y: 70, z: -90 };
    const plan = planStructure('simple_house', origin, { size: 5, height: 4 });
    const planned = new Set(plan.map(key));

    expect(planned.has(key({ x: origin.x + 2, y: origin.y + 1, z: origin.z + 4 }))).toBe(false);
    expect(planned.has(key({ x: origin.x + 1, y: origin.y + 1, z: origin.z + 4 }))).toBe(true);
  });
});

describe('build_structure audit - the block cap', () => {
  it('builds the whole house, roof included, when the request is bigger than the cap', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 1000 } });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      {
        structure: 'simple_house',
        position: { x: 200, y: 64, z: 200 },
        dimensions: { size: 9, height: 6 },
      },
      test.ctx,
    );

    expect(result.ok).toBe(true);
    expect(facade.placedPositions.length).toBeLessThanOrEqual(MAX_BUILD_BLOCKS);

    // The roof is a full rectangle: no hole is left in the top layer.
    const placed = facade.placedPositions.map((p) => p.at);
    const roofY = Math.max(...placed.map((p) => p.y));
    const roof = placed.filter((p) => p.y === roofY);
    const xs = new Set(roof.map((p) => p.x));
    const zs = new Set(roof.map((p) => p.z));
    expect(roof.length).toBe(xs.size * zs.size);
  });

  it('keeps the wall whole when it does not fit into the cap', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 1000 } });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      {
        structure: 'wall',
        position: { x: 10, y: 64, z: 10 },
        dimensions: { length: 24, height: 12 },
      },
      test.ctx,
    );

    expect(result.ok).toBe(true);
    expect(facade.placedPositions.length).toBeLessThanOrEqual(MAX_BUILD_BLOCKS);

    // Every column of the wall is the full height - the wall is not cut off.
    const placed = facade.placedPositions.map((p) => p.at);
    const columns = new Map<number, Set<number>>();
    for (const at of placed) {
      const heights = columns.get(at.x) ?? new Set<number>();
      heights.add(at.y);
      columns.set(at.x, heights);
    }
    const distinctHeights = new Set([...columns.values()].map((heights) => heights.size));
    expect(distinctHeights.size).toBe(1);
  });
});

describe('build_structure audit - a stuck run', () => {
  it('gives up when the blocks cannot be placed', async () => {
    const facade = new FailingFacade({ inventory: { cobblestone: 1000 } });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      {
        structure: 'platform',
        position: { x: 0, y: 64, z: 0 },
        dimensions: { length: 16, width: 16 },
      },
      test.ctx,
    );

    expect(result.ok).toBe(false);
    // The run gives up instead of trying every one of the 256 cells.
    expect(facade.attempts).toBeLessThan(MAX_BUILD_BLOCKS);
    expect(result.detail).toMatch(/could not place/i);
  });
});

describe('build_structure audit - the safety rules stay in place', () => {
  it('refuses a dangerous material', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { tnt: 100 } });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      {
        structure: 'wall',
        position: { x: 0, y: 64, z: 0 },
        dimensions: { length: 2, height: 2 },
        material: 'tnt',
      },
      test.ctx,
    );

    expect(result.ok).toBe(false);
    expect(facade.placedPositions).toHaveLength(0);
  });

  it('only asks for the blocks that are actually missing', async () => {
    const facade = new FakeMinecraftFacade({ inventory: { cobblestone: 10 } });
    // Two of the four platform cells already hold the material.
    facade.addBlock('cobblestone', { x: 0, y: 64, z: 0 });
    facade.addBlock('cobblestone', { x: 1, y: 64, z: 0 });
    const skill = new BuildStructureSkill(facade);
    const test = createTestContext();

    const result = await skill.execute(
      { structure: 'platform', position: { x: 0, y: 64, z: 0 }, dimensions: { length: 2, width: 2 } },
      test.ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(facade.placedPositions).toHaveLength(2);
  });
});
