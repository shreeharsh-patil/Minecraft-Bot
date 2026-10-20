import { describe, expect, it } from 'vitest';
import { MineBlockSkill } from '../../src/skills/mining/mineBlock.js';
import { CollectResourceSkill } from '../../src/skills/mining/collectResource.js';
import { resolveResourceNames, MAX_BLOCKS_PER_TASK } from '../../src/skills/mining/shared.js';
import { FakeMinecraftFacade } from './fakes/fakeFacade.js';
import { createTestContext } from './helpers/testContext.js';

function forest(count: number): FakeMinecraftFacade {
  const blocks = Array.from({ length: count }, (_unused, i) => ({
    name: 'oak_log',
    at: { x: 2 + i, y: 64, z: 0 },
  }));
  return new FakeMinecraftFacade({
    position: { x: 0, y: 64, z: 0 },
    blocks,
    inventory: { iron_axe: 1 },
    tools: { oak_log: 'iron_axe' },
  });
}

describe('MineBlockSkill', () => {
  it('mines exactly the requested count and stops there', async () => {
    const facade = forest(10);
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'oak_log', count: 3 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
    expect(facade.dugPositions).toHaveLength(3);
    expect(facade.countItem('oak_log')).toBe(3);
    expect(test.progressUpdates.map((p) => p.current)).toContain(3);
    expect(test.progressUpdates.at(-1)?.fraction).toBe(1);
  });

  it('selects and equips the right tool before digging', async () => {
    const facade = forest(2);
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    await skill.execute({ blockName: 'oak_log', count: 1 }, test.ctx);

    expect(facade.calls).toContain('selectToolFor:oak_log');
    expect(facade.equippedItems).toContain('iron_axe');
    expect(facade.calls.indexOf('selectToolFor:oak_log')).toBeLessThan(facade.calls.indexOf('digBlock'));
  });

  it('honours ctx.signal and stops mining mid-task', async () => {
    const facade = forest(20);
    facade.digDelayMs = 5;
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    // Cancel from the walk that precedes the fourth dig, so the run always
    // stops at the same place. The old version used a 40ms timer: when it
    // landed in the middle of a dig, the block was dug but not counted and
    // the assertion below (dug == mined) broke.
    const originalMove = facade.moveToPosition.bind(facade);
    let walks = 0;
    facade.moveToPosition = async (target, options) => {
      walks += 1;
      if (walks === 4) test.abort();
      return originalMove(target, options);
    };

    const result = await skill.execute({ blockName: 'oak_log', count: 20 }, test.ctx);

    const mined = result.count ?? 0;
    expect(result.ok).toBe(false);
    expect(mined).toBeGreaterThan(0);
    expect(mined).toBeLessThan(20);
    expect(mined).toBe(3);
    expect(result.remaining).toBe(20 - mined);
    expect(facade.dugPositions).toHaveLength(mined);
  });

  it('returns immediately when already aborted', async () => {
    const facade = forest(5);
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();
    test.abort();

    const result = await skill.execute({ blockName: 'oak_log', count: 5 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.dugPositions).toHaveLength(0);
  });

  it('clamps absurd requests to the safety maximum', async () => {
    const facade = forest(3);
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'oak_log', count: 100_000 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.count).toBe(3);
    expect(result.remaining).toBe(MAX_BLOCKS_PER_TASK - 3);
  });

  it('reports honestly when there is nothing to mine', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'diamond_ore', count: 2 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.count).toBe(0);
    expect(result.remaining).toBe(2);
    expect(result.detail).toMatch(/ran out of/i);
  });

  it('explains a missing tool rather than looping forever', async () => {
    const facade = new FakeMinecraftFacade({
      blocks: [{ name: 'stone', at: { x: 3, y: 64, z: 0 } }],
    });
    facade.undiggable.add('stone');
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'stone', count: 1 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/pickaxe/i);
  });
});

describe('CollectResourceSkill', () => {
  it('resolves a human phrase and mines it', async () => {
    const facade = forest(5);
    const skill = new CollectResourceSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ resource: 'oak logs', count: 2 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
  });

  it('accepts several wood types for a generic "wood"', async () => {
    const facade = new FakeMinecraftFacade({
      blocks: [
        { name: 'birch_log', at: { x: 3, y: 64, z: 0 } },
        { name: 'spruce_log', at: { x: -4, y: 64, z: 0 } },
      ],
    });
    const skill = new CollectResourceSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ resource: 'wood', count: 2 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
  });

  it('rejects an unknown resource without touching the world', async () => {
    const facade = forest(3);
    const skill = new CollectResourceSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ resource: 'wat', count: 1 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.dugPositions).toHaveLength(0);
  });
});

describe('resolveResourceNames', () => {
  it('maps common phrases to block names', () => {
    expect(resolveResourceNames('oak logs')).toEqual(['oak_log']);
    expect(resolveResourceNames('cobblestone')).toEqual(['cobblestone']);
    expect(resolveResourceNames('wood')).toContain('oak_log');
    expect(resolveResourceNames('Iron Ore')).toEqual(['iron_ore']);
    expect(resolveResourceNames('planks')).toContain('oak_planks');
    expect(resolveResourceNames('dirt')).toContain('dirt');
  });
});