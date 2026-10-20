/**
 * Audit regressions for the `collect_resource` skill.
 *
 * The skill gathers a named material and, when the player names a place, is
 * supposed to say where it gathered it from. Each test below pins a defect
 * that was found by reading the skill line by line; every one of them fails
 * against the unfixed skill.
 */
import { describe, expect, it } from 'vitest';
import { CollectResourceSkill } from '../../src/skills/mining/collectResource.js';
import { validateAction } from '../../src/executor/validator.js';
import type { CollectResourceAction } from '../../src/types/actions.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { createTestContext } from '../skills/helpers/testContext.js';

/** A world with `count` iron ore blocks a few steps away. */
function oreWorld(count: number): FakeMinecraftFacade {
  const blocks = Array.from({ length: count }, (_unused, i) => ({
    name: 'iron_ore',
    at: { x: 3 + i, y: 64, z: 0 },
  }));
  return new FakeMinecraftFacade({
    inventory: { iron_pickaxe: 1 },
    blocks,
    tools: { iron_ore: 'iron_pickaxe' },
  });
}

/** A world with `count` oak logs a few steps away. */
function forest(count: number): FakeMinecraftFacade {
  const blocks = Array.from({ length: count }, (_unused, i) => ({
    name: 'oak_log',
    at: { x: 3 + i, y: 64, z: 0 },
  }));
  return new FakeMinecraftFacade({
    inventory: { iron_axe: 1 },
    blocks,
    tools: { oak_log: 'iron_axe' },
  });
}

/** The action the executor would really run for this request. */
function validated(raw: Record<string, unknown>): CollectResourceAction {
  const result = validateAction({ type: 'collect_resource', ...raw });
  if (!result.valid || !result.action) {
    throw new Error(`action rejected by the validator: ${result.reason ?? 'unknown'}`);
  }
  return result.action as CollectResourceAction;
}

describe('collect_resource - a partly finished run says what it got', () => {
  /**
   * The skill reported the reason the mining stopped ("I ran out of iron")
   * and threw away its own "I only collected 3 of 5 iron". Only the detail
   * reaches the player, so a collection that got half of what was asked for
   * looked like a collection that got nothing.
   */
  it('reports the partial count next to the reason', async () => {
    const facade = oreWorld(3);
    const skill = new CollectResourceSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ resource: 'iron', count: 5 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.count).toBe(3);
    expect(result.remaining).toBe(2);
    // The reason is still there...
    expect(result.detail).toMatch(/ran out of iron/i);
    // ...and so is the count that says how much was collected.
    expect(result.detail).toMatch(/3 of 5/);
  });

  it('still reports the reason alone when nothing was collected', async () => {
    const facade = oreWorld(0);
    const skill = new CollectResourceSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ resource: 'iron', count: 5 }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.count).toBe(0);
    expect(result.detail).toMatch(/ran out of iron/i);
    expect(result.detail).not.toMatch(/I collected 0 of 5/);
  });
});

describe('collect_resource - the location is quoted the way the player said it', () => {
  /**
   * The validator canonicalises a location ("the mine" -> "the_mine"), and
   * the skill quoted that spelling back at the player: "I don't know where
   * "the_mine" is" - a word the player never typed.
   */
  it('answers with the words of the request, not the validator spelling', async () => {
    const facade = oreWorld(3);
    const skill = new CollectResourceSkill(facade);
    const test = createTestContext();

    const action = validated({ resource: 'iron', count: 1, from: 'the mine' });
    const result = await skill.execute(action, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/don't know where "the mine" is/i);
    expect(result.detail).not.toMatch(/the_mine/);
    expect(facade.dugPositions).toHaveLength(0);
  });

  /**
   * "around here" is the place the player is standing in - the bot knows it
   * perfectly well. The validator turned it into "around_here", which was not
   * in the list of "here" words, so the bot refused and claimed it did not
   * know where it was.
   */
  it('honours a here-phrase such as "around here"', async () => {
    const facade = oreWorld(3);
    const skill = new CollectResourceSkill(facade);
    const test = createTestContext();

    const action = validated({ resource: 'iron', count: 2, from: 'around here' });
    const result = await skill.execute(action, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.detail).toMatch(/around here/);
    expect(facade.dugPositions).toHaveLength(2);
  });

  it('still refuses a named place it cannot resolve', async () => {
    const facade = oreWorld(3);
    const skill = new CollectResourceSkill(facade);
    const test = createTestContext();

    const action = validated({ resource: 'iron', count: 1, from: 'home' });
    const result = await skill.execute(action, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/don't know where "home" is/i);
    // Nothing was mined, so no false claim can be made.
    expect(facade.dugPositions).toHaveLength(0);
    expect(result.count).toBe(0);
  });
});

describe('collect_resource - the resource is named the way Minecraft names it', () => {
  /**
   * The label was the raw request, so a request for the block "oak_log" was
   * reported as "Collected 2 oak log." The shared helper for this exists
   * ("oak_log" -> "oak logs") and the sibling skill uses it.
   */
  it('reports a block name in the plural', async () => {
    const facade = forest(3);
    const skill = new CollectResourceSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ resource: 'oak_log', count: 2 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.detail).toBe('Collected 2 oak logs.');
  });

  it('still reports a human phrase as the player said it', async () => {
    const facade = forest(3);
    const skill = new CollectResourceSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ resource: 'oak logs', count: 2 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.detail).toBe('Collected 2 oak logs.');
  });
});
