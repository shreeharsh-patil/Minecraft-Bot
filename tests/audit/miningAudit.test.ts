/**
 * Audit of the shared mining loop (`src/skills/mining/shared.ts`).
 *
 * Every test here failed before the fix it guards.
 */
import { describe, expect, it } from 'vitest';
import { MineBlockSkill } from '../../src/skills/mining/mineBlock.js';
import { resolveResourceNames } from '../../src/skills/mining/shared.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';

/**
 * A facade that behaves like the real one: `selectToolFor` only ever offers
 * the tool the bot is ALREADY holding, and only when it suits the block.
 */
class HeldToolFacade extends FakeMinecraftFacade {
  public override selectToolFor(blockName: string): Promise<string | null> {
    this.calls.push(`selectToolFor:${blockName}`);
    const held = this.heldItem();
    if (held === null) return Promise.resolve(null);
    if (held.includes('pickaxe') && !blockName.includes('log')) return Promise.resolve(held);
    if (held.includes('axe') && blockName.includes('log')) return Promise.resolve(held);
    if (held.includes('shovel') && !blockName.includes('log')) return Promise.resolve(held);
    return Promise.resolve(null);
  }
}

/** The tool the bot was holding when it dug. */
function toolUsedForTheDig(facade: FakeMinecraftFacade): string | undefined {
  const digIndex = facade.calls.indexOf('digBlock');
  const before = facade.calls.slice(0, digIndex);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const call = before[i];
    if (call !== undefined && call.startsWith('equipItem:')) return call.slice('equipItem:'.length);
  }
  return undefined;
}

describe('mining equips the tool the block needs', () => {
  it('equips a tool from the inventory when the bot holds none', async () => {
    const facade = new HeldToolFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'stone', at: { x: 3, y: 64, z: 0 } }],
      inventory: { iron_pickaxe: 1 },
    });
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'stone', count: 1 }, test.ctx);

    expect(result.ok).toBe(true);
    // The pickaxe was in the inventory all along: it must be equipped before
    // the dig, not left in the backpack.
    expect(toolUsedForTheDig(facade)).toBe('iron_pickaxe');
    expect(facade.calls.indexOf('equipItem:iron_pickaxe')).toBeLessThan(
      facade.calls.indexOf('digBlock'),
    );
  });

  it('does not dig stone with a shovel it happens to hold', async () => {
    const facade = new HeldToolFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'stone', at: { x: 3, y: 64, z: 0 } }],
      inventory: { iron_shovel: 1, iron_pickaxe: 1 },
    });
    // The bot is holding the shovel; the pickaxe is in the backpack.
    await facade.equipItem('iron_shovel');
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'stone', count: 1 }, test.ctx);

    expect(result.ok).toBe(true);
    // Stone drops cobblestone only for a pickaxe.
    expect(toolUsedForTheDig(facade)).toBe('iron_pickaxe');
  });

  it('does not chop a log with the pickaxe it happens to hold', async () => {
    const facade = new HeldToolFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'oak_log', at: { x: 3, y: 64, z: 0 } }],
      inventory: { iron_pickaxe: 1, iron_axe: 1 },
    });
    await facade.equipItem('iron_pickaxe');
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'oak_log', count: 1 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(toolUsedForTheDig(facade)).toBe('iron_axe');
  });

  it('does not tell the player it has no tool when it owns one', async () => {
    const facade = new HeldToolFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'stone', at: { x: 3, y: 64, z: 0 } }],
      inventory: { iron_pickaxe: 1 },
    });
    facade.undiggable.add('stone');
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'stone', count: 1 }, test.ctx);

    expect(result.ok).toBe(false);
    // The bot owns a pickaxe, so it must not claim that it has none.
    expect(result.detail).not.toMatch(/no pickaxe/i);
  });

  it('still says so when the bot owns no tool at all', async () => {
    const facade = new HeldToolFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'stone', at: { x: 3, y: 64, z: 0 } }],
    });
    facade.undiggable.add('stone');
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'stone', count: 1 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no pickaxe/i);
  });
});

describe('resolveResourceNames', () => {
  it('maps "birch wood" to birch_log, as the comment promises', () => {
    expect(resolveResourceNames('birch wood')).toEqual(['birch_log']);
    expect(resolveResourceNames('oak wood')).toEqual(['oak_log']);
    expect(resolveResourceNames('dark oak wood')).toEqual(['dark_oak_log']);
  });

  it('does not invent a log for a wood that is not a tree', () => {
    expect(resolveResourceNames('bamboo wood')).not.toContain('bamboo_log');
  });

  it('keeps the phrases it already understood', () => {
    expect(resolveResourceNames('oak logs')).toEqual(['oak_log']);
    expect(resolveResourceNames('wood')).toContain('oak_log');
    expect(resolveResourceNames('cobblestone')).toEqual(['cobblestone']);
    expect(resolveResourceNames('iron ore')).toEqual(['iron_ore']);
  });
});

describe('the mining search looks past the blocks it cannot use', () => {
  it('mines natural cobblestone even when its own wall fills the nearest window', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      inventory: { cobblestone: 40 },
    });
    // The bot built a wall of sixteen blocks right next to itself...
    for (let i = 1; i <= 16; i += 1) {
      await facade.placeBlock({ x: i, y: 64, z: 0 }, 'cobblestone');
    }
    // ...and there is natural cobblestone a few blocks further away.
    facade.addBlock('cobblestone', { x: 20, y: 64, z: 0 });

    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'cobblestone', count: 1 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    // The natural block was mined, the bot's own wall was left alone.
    expect(facade.dugPositions.map((p) => `${p.x},${p.y},${p.z}`)).toEqual(['20,64,0']);
  });
});

describe('mine_block understands a request phrased in words', () => {
  it('mines oak logs when the request says "oak wood"', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'oak_log', at: { x: 3, y: 64, z: 0 } }],
      inventory: { iron_axe: 1 },
    });
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'oak wood', count: 1 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(facade.dugPositions.map((p) => `${p.x},${p.y},${p.z}`)).toEqual(['3,64,0']);
  });

  it('mines iron ore when the request says "iron"', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'iron_ore', at: { x: 3, y: 64, z: 0 } }],
      inventory: { iron_pickaxe: 1 },
    });
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'iron', count: 1 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
  });

  it('still mines the exact block when the name is a real one', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [
        { name: 'dirt', at: { x: 3, y: 64, z: 0 } },
        { name: 'grass_block', at: { x: 4, y: 64, z: 0 } },
      ],
    });
    const skill = new MineBlockSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ blockName: 'dirt', count: 1 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    // "dirt" is a block on its own: only dirt is mined, not grass blocks.
    expect(facade.dugPositions.map((p) => `${p.x},${p.y},${p.z}`)).toEqual(['3,64,0']);
  });
});
