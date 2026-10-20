/**
 * Audit of the shared constant tables (`src/config/constants.ts`).
 *
 * The tables look like data, so nothing complains when an entry goes stale -
 * the bot simply stops seeing a threat, or mines a block with a tool that
 * cannot harvest it. These checks pin the behaviour that matters:
 *
 *  - every hostile mob of Minecraft 1.21.1 is a threat (the bot targets
 *    1.21.1, see `src/bot/versionSupport.ts`);
 *  - the mob table has no duplicated entries;
 *  - a block is never listed with a generic tool AND a specific tool tier;
 *  - a block that needs a pickaxe is never advertised as hand-minable;
 *  - the conflict groups exist exactly once in the codebase.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_TOOL,
  CONFLICT_GROUP,
  DANGEROUS_BLOCKS,
  FOODS,
  HOSTILE_MOB_FAMILIES,
  SOFT_BLOCKS,
} from '../../src/config/constants.js';
import { CONFLICT_GROUP as CANONICAL_CONFLICT_GROUP } from '../../src/types/task.js';

/** Every hostile mob of Minecraft 1.21.1 (the version the bot speaks). */
const VANILLA_HOSTILE_MOBS: readonly string[] = [
  'zombie',
  'husk',
  'drowned',
  'zombie_villager',
  'zombie_horse',
  'skeleton',
  'stray',
  'bogged',
  'wither_skeleton',
  'creeper',
  'spider',
  'cave_spider',
  'enderman',
  'witch',
  'slime',
  'magma_cube',
  'blaze',
  'silverfish',
  'endermite',
  'guardian',
  'elder_guardian',
  'phantom',
  'piglin_brute',
  'zombified_piglin',
  'ghast',
  'hoglin',
  'zoglin',
  'warden',
  'evoker',
  'vex',
  'illusioner',
  'ravager',
  'pillager',
  'vindicator',
  'breeze',
  'shulker',
  'wither',
];

/**
 * Mobs that are neutral or passive. They must never be treated as threats:
 * a piglin only becomes hostile as a `zombified_piglin`, which is its own
 * entity id.
 */
const NEUTRAL_OR_PASSIVE_MOBS: readonly string[] = [
  'piglin',
  'iron_golem',
  'snow_golem',
  'villager',
  'wandering_trader',
  'allay',
  'bat',
  'cow',
  'pig',
  'sheep',
  'chicken',
  'rabbit',
  'horse',
  'donkey',
  'mule',
  'cat',
  'wolf',
  'fox',
  'bee',
  'axolotl',
  'goat',
  'turtle',
  'panda',
  'polar_bear',
  'llama',
  'trader_llama',
  'sniffer',
  'camel',
  'armadillo',
  'frog',
  'tadpole',
  'squid',
  'glow_squid',
  'cod',
  'salmon',
  'tropical_fish',
  'pufferfish',
];

/** Vanilla blocks that hurt the bot and must never be walked into or dug. */
const VANILLA_DAMAGING_BLOCKS: readonly string[] = [
  'lava',
  'flowing_lava',
  'fire',
  'soul_fire',
  'magma_block',
  'campfire',
  'soul_campfire',
  'cactus',
  'powder_snow',
  'sweet_berry_bush',
  'wither_rose',
  'tnt',
  'water',
  'flowing_water',
];

/** Foods that can poison or starve the bot - they never belong in the list. */
const UNSAFE_FOODS: readonly string[] = [
  'raw_beef',
  'raw_porkchop',
  'raw_chicken',
  'raw_mutton',
  'raw_rabbit',
  'raw_cod',
  'raw_salmon',
  'pufferfish',
  'chorus_fruit',
  'suspicious_stew',
  'spider_eye',
  'poisonous_potato',
];

/** A tool name, optionally with a tier prefix ("diamond_pickaxe"). */
const TOOL_NAME = /^(?:[a-z]+_)?(axe|pickaxe|shovel|hoe|sword|shears)$/;

const CONSTANTS_SOURCE = readFileSync(
  new URL('../../src/config/constants.ts', import.meta.url),
  'utf8',
);

/**
 * The string literals of a `new Set([...])` constant, in source order.
 *
 * The set itself hides duplicates, so the source is the only place a
 * duplicated entry can still be seen.
 */
function literalEntries(constName: string): string[] {
  const start = CONSTANTS_SOURCE.indexOf(`export const ${constName}`);
  if (start === -1) throw new Error(`${constName} not found in constants.ts`);
  const end = CONSTANTS_SOURCE.indexOf(']);', start);
  if (end === -1) throw new Error(`end of ${constName} not found in constants.ts`);
  const body = CONSTANTS_SOURCE.slice(start, end);
  return Array.from(body.matchAll(/'([^']+)'/g), (match) => match[1] ?? '');
}

describe('HOSTILE_MOB_FAMILIES', () => {
  it('treats every hostile mob of 1.21.1 as a threat', () => {
    const missing = VANILLA_HOSTILE_MOBS.filter((mob) => !HOSTILE_MOB_FAMILIES.has(mob));
    expect(missing).toEqual([]);
  });

  it('does not treat neutral or passive mobs as threats', () => {
    const wrongly = NEUTRAL_OR_PASSIVE_MOBS.filter((mob) => HOSTILE_MOB_FAMILIES.has(mob));
    expect(wrongly).toEqual([]);
  });

  it('lists every mob family exactly once', () => {
    const entries = literalEntries('HOSTILE_MOB_FAMILIES');
    const duplicates = entries.filter((entry, index) => entries.indexOf(entry) !== index);
    expect(duplicates).toEqual([]);
    // The set hides duplicates, so the source length is the real count.
    expect(entries.length).toBe(HOSTILE_MOB_FAMILIES.size);
  });
});

describe('BLOCK_TOOL', () => {
  it('prefers a tool that can actually harvest the block', () => {
    // Obsidian drops itself only for a diamond (or netherite) pickaxe.
    expect(BLOCK_TOOL['obsidian']).toEqual(['diamond_pickaxe']);
  });

  it('never lists a generic tool and a specific tier for the same block', () => {
    for (const [block, tools] of Object.entries(BLOCK_TOOL)) {
      const generic = tools.filter((tool) => !tool.includes('_'));
      const tiered = tools.filter((tool) => tool.includes('_'));
      const mixes = generic.length > 0 && tiered.length > 0;
      expect(mixes, `BLOCK_TOOL.${block} mixes a generic tool with a specific tier`).toBe(false);
    }
  });

  it('names a real tool for every block', () => {
    for (const [block, tools] of Object.entries(BLOCK_TOOL)) {
      for (const tool of tools) {
        expect(TOOL_NAME.test(tool), `BLOCK_TOOL.${block} -> ${tool}`).toBe(true);
      }
    }
  });
});

describe('SOFT_BLOCKS', () => {
  it('never advertises a pickaxe block as hand-minable', () => {
    for (const [block, tools] of Object.entries(BLOCK_TOOL)) {
      if (!tools.includes('pickaxe')) continue;
      expect(SOFT_BLOCKS.has(block), `${block} needs a pickaxe but is listed as a soft block`).toBe(false);
    }
  });
});

describe('DANGEROUS_BLOCKS', () => {
  it('keeps every vanilla damaging block on the danger list', () => {
    const missing = VANILLA_DAMAGING_BLOCKS.filter((block) => !DANGEROUS_BLOCKS.has(block));
    expect(missing).toEqual([]);
  });
});

describe('FOODS', () => {
  it('keeps the safest food first and the risky one last', () => {
    expect(FOODS[0]).toBe('golden_carrot');
    expect(FOODS[FOODS.length - 1]).toBe('rotten_flesh');
  });

  it('never lists a food that can poison the bot', () => {
    const listed = FOODS.filter((food) => UNSAFE_FOODS.includes(food));
    expect(listed).toEqual([]);
  });

  it('lists every food exactly once', () => {
    const duplicates = FOODS.filter((food, index) => FOODS.indexOf(food) !== index);
    expect(duplicates).toEqual([]);
  });
});

describe('CONFLICT_GROUP', () => {
  it('is the same table as the one in src/types/task.ts', () => {
    // Two copies of this table are free to drift apart, which is exactly what
    // happened to the old ACTION_TYPES copy.
    expect(CONFLICT_GROUP).toBe(CANONICAL_CONFLICT_GROUP);
  });

  it('still holds the documented groups', () => {
    expect(CONFLICT_GROUP).toEqual({
      MOVEMENT: 'movement',
      MINING: 'mining',
      BUILDING: 'building',
      INVENTORY: 'inventory',
      COMBAT: 'combat',
      NONE: 'none',
    });
  });
});
