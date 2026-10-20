/**
 * Audit of the algorithmic (offline) planner.
 *
 * The local planner is the bot's brain when no AI API key is configured, so
 * a mistake here is a mistake in every deployment that runs without a key.
 * Each test below pins a defect that was found by reading the planner line
 * by line; every one of them fails on the unfixed code.
 */
import { describe, expect, it } from 'vitest';
import { LocalPlanner } from '../../src/ai/localPlanner.js';
import { validateAction } from '../../src/executor/validator.js';
import type { CompactContext } from '../../src/ai/contextBuilder.js';
import type { PlanRequest } from '../../src/ai/planner.js';

const baseContext: CompactContext = {
  position: { x: 12, y: 64, z: -8 },
  dimension: 'overworld',
  timeOfDay: 'day',
  health: { current: 20, max: 20 },
  hunger: { current: 20, saturation: 5 },
  task: null,
  targetPlayer: null,
  nearbyPlayers: [{ name: 'Alice', distance: 4, authorized: true, health: 20 }],
  nearbyHostiles: [],
  nearbyBlocks: [{ name: 'stone', distance: 2 }, { name: 'oak_log', distance: 5 }],
  dangerousBlocksNearby: [],
  inventory: {
    held: null,
    usedSlots: 2,
    freeSlots: 33,
    items: [{ name: 'iron_sword', count: 1 }, { name: 'cooked_beef', count: 8 }],
  },
  recentChat: [],
};

function context(overrides: Partial<CompactContext> = {}): CompactContext {
  return { ...baseContext, ...overrides };
}

function request(text: string, overrides: Partial<PlanRequest> = {}): PlanRequest {
  return { instruction: text, requester: 'Alice', context: baseContext, ...overrides };
}

const planner = new LocalPlanner();

describe('LocalPlanner audit - clamps stay inside the shared ceilings', () => {
  /**
   * The planner used to clamp a wait to 60s while the validator (and the
   * executor) refuse anything above 30s, so "wait 60 seconds" produced an
   * action that was dropped and the bot did nothing at all.
   */
  it('keeps a long wait inside the ceiling the validator accepts', async () => {
    const result = await planner.plan(request('wait 60 seconds'));
    const wait = result.actions[0];
    expect(wait?.type).toBe('wait');
    expect(wait?.type === 'wait' && wait.durationMs).toBeGreaterThan(0);
    expect(wait?.type === 'wait' && wait.durationMs).toBeLessThanOrEqual(30_000);
    expect(result.dropped).toEqual([]);
  });

  it('keeps a long wait in minutes inside the ceiling too', async () => {
    const result = await planner.plan(request('wait 2 minutes'));
    const wait = result.actions[0];
    expect(wait?.type).toBe('wait');
    expect(wait?.type === 'wait' && wait.durationMs).toBeLessThanOrEqual(30_000);
    expect(result.dropped).toEqual([]);
  });

  it('still waits exactly as long as asked when that is allowed', async () => {
    const result = await planner.plan(request('wait 5 seconds'));
    expect(result.actions[0]).toMatchObject({ type: 'wait', durationMs: 5000 });
  });

  /**
   * A drop was clamped to 2304 while the validator refuses more than 64, so
   * "drop 100 iron_sword" was silently dropped and nothing happened.
   */
  it('keeps a drop count inside the ceiling the validator accepts', async () => {
    const result = await planner.plan(request('drop 100 iron_sword'));
    const drop = result.actions[0];
    expect(drop?.type).toBe('drop_item');
    expect(drop?.type === 'drop_item' && drop.count).toBeLessThanOrEqual(64);
    expect(result.dropped).toEqual([]);
  });

  it('drops exactly as many items as asked when that is allowed', async () => {
    const result = await planner.plan(request('drop 3 iron_sword'));
    expect(result.actions[0]).toMatchObject({ type: 'drop_item', item: 'iron_sword', count: 3 });
  });
});

describe('LocalPlanner audit - intents fire for the right input', () => {
  /**
   * Coordinates used to out-score every verb, so "look at 100 64 -200" made
   * the bot WALK there instead of looking at it - the look_at branch of
   * buildLook() was unreachable.
   */
  it('looks at coordinates instead of walking to them', async () => {
    const result = await planner.plan(request('look at 10 64 -5'));
    expect(result.actions[0]).toMatchObject({
      type: 'look_at',
      position: { x: 10, y: 64, z: -5 },
    });
  });

  it('still walks when the player asks to go somewhere', async () => {
    const result = await planner.plan(request('go to 100 64 -200'));
    expect(result.actions[0]).toMatchObject({
      type: 'move_to_position',
      position: { x: 100, y: 64, z: -200 },
    });
  });

  it('still walks when coordinates are the whole request', async () => {
    const result = await planner.plan(request('100 64 -200'));
    expect(result.actions[0]).toMatchObject({
      type: 'move_to_position',
      position: { x: 100, y: 64, z: -200 },
    });
  });

  /**
   * "collect the drops" is listed as a pickup phrase, but the single word
   * "collect" (a mining verb) scored exactly the same and won the tie, so
   * the pickup phrase could never fire.
   */
  it('picks the drops up when the player asks for the drops', async () => {
    const result = await planner.plan(request('collect the drops'));
    expect(result.actions[0]).toMatchObject({ type: 'pickup_items' });
  });

  it('still mines when the player asks to collect a block', async () => {
    const result = await planner.plan(request('collect 5 wood'));
    expect(result.actions[0]).toMatchObject({ type: 'mine_block', count: 5 });
  });
});

describe('LocalPlanner audit - the count belongs to the thing that was named', () => {
  /**
   * The quantity used to be taken from the first match in the phrase table
   * rather than from the part of the sentence that names the target, so
   * "mine 20 logs and 5 stone" mined TWENTY stone.
   */
  it('counts the stone, not the logs, in "mine 20 logs and 5 stone"', async () => {
    const result = await planner.plan(request('mine 20 logs and 5 stone'));
    expect(result.actions[0]).toMatchObject({ type: 'mine_block', blockName: 'stone', count: 5 });
  });

  it('counts the logs, not the stone, in "bring me a couple of stone and a few logs"', async () => {
    const result = await planner.plan(request('bring me a couple of stone and a few logs'));
    expect(result.actions[0]).toMatchObject({ type: 'mine_block', count: 3 });
  });

  it('still reads a plain count correctly', async () => {
    const result = await planner.plan(request('mine 20 logs'));
    expect(result.actions[0]).toMatchObject({ type: 'mine_block', count: 20 });
  });

  it('still reads a number word correctly', async () => {
    const result = await planner.plan(request('mine twenty cobblestone'));
    expect(result.actions[0]).toMatchObject({ type: 'mine_block', blockName: 'cobblestone', count: 20 });
  });

  it('still reads a vague quantity correctly', async () => {
    const result = await planner.plan(request('collect a few wood'));
    expect(result.actions[0]).toMatchObject({ type: 'mine_block', count: 3 });
  });
});

describe('LocalPlanner audit - world grounding', () => {
  const spruceNearby = context({
    nearbyBlocks: [{ name: 'spruce_log', distance: 3 }, { name: 'stone', distance: 8 }],
  });

  /**
   * "oak_log" is the default for generic wood, so a player who explicitly
   * asked for oak got the nearest tree instead - the wrong block.
   */
  it('mines the species the player named', async () => {
    const result = await planner.plan(request('mine 20 oak logs', { context: spruceNearby }));
    expect(result.actions[0]).toMatchObject({ type: 'mine_block', blockName: 'oak_log', count: 20 });
  });

  it('mines the species the player named for wood too', async () => {
    const result = await planner.plan(request('mine 20 oak wood', { context: spruceNearby }));
    expect(result.actions[0]).toMatchObject({ type: 'mine_block', blockName: 'oak_log' });
  });

  it('still serves generic wood with the tree that stands nearby', async () => {
    const result = await planner.plan(request('mine 20 logs', { context: spruceNearby }));
    expect(result.actions[0]).toMatchObject({ type: 'mine_block', blockName: 'spruce_log', count: 20 });
  });
});

describe('LocalPlanner audit - answers are grounded in what the bot holds', () => {
  const holdingDiamonds = context({
    inventory: {
      held: null,
      usedSlots: 3,
      freeSlots: 32,
      items: [
        { name: 'iron_sword', count: 1 },
        { name: 'cooked_beef', count: 8 },
        { name: 'diamond', count: 5 },
      ],
    },
  });

  /**
   * The vocabulary only knows the block "diamond_ore", so the answer counted
   * ore and reported zero while the bot was holding five diamonds.
   */
  it('counts the diamonds the bot actually holds', async () => {
    const result = await planner.plan(
      request('how many diamonds do you have', { context: holdingDiamonds }),
    );
    const say = result.actions[0];
    expect(say?.type).toBe('say');
    expect(say?.type === 'say' && say.message).toContain('5');
    expect(say?.type === 'say' && say.message).not.toContain('0 ');
  });

  it('still counts a named item that is not in the vocabulary', async () => {
    const result = await planner.plan(request('how many iron swords do you have?'));
    const say = result.actions[0];
    expect(say?.type === 'say' && say.message).toContain('1');
  });
});

describe('LocalPlanner audit - small talk is matched on whole words', () => {
  /**
   * "ty" was matched as a prefix, so any word starting with "ty" ("type..." )
   * was answered with "You're welcome".
   */
  it('does not treat a word that merely starts with "ty" as thanks', async () => {
    const result = await planner.plan(request('typewriter'));
    const say = result.actions[0];
    expect(say?.type === 'say' && say.message).not.toContain("You're welcome");
  });

  it('still says thanks are welcome', async () => {
    const result = await planner.plan(request('thanks'));
    const say = result.actions[0];
    expect(say?.type === 'say' && say.message).toContain("You're welcome");
  });
});

describe('LocalPlanner audit - everything it emits is still allowlisted', () => {
  const corpus = [
    'wait 60 seconds',
    'wait 2 minutes',
    'drop 100 iron_sword',
    'look at 10 64 -5',
    'turn to 10 64 -5',
    'collect the drops',
    'mine 20 logs and 5 stone',
    'bring me a couple of stone and a few logs',
    'mine 20 oak logs',
    'how many diamonds do you have',
    'typewriter',
  ];

  it('passes the shared validator for every request in the corpus', async () => {
    for (const instruction of corpus) {
      const result = await planner.plan(request(instruction));
      expect(result.actions.length, instruction).toBeGreaterThan(0);
      for (const action of result.actions) {
        const checked = validateAction(action);
        expect(checked.valid, `"${instruction}" produced an invalid action: ${checked.reason ?? 'unknown'}`).toBe(true);
      }
    }
  });
});
