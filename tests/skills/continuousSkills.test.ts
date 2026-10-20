/**
 * The continuous skills: follow and defend.
 *
 * Both hold the bot's body for as long as they run, so they must always end
 * on their own - a skill that never returns keeps its conflict group claimed
 * and the player never gets a result. They must also stay quiet: a line of
 * chat every half second is spam, and a server will kick the bot for it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowPlayerSkill, DEFAULT_FOLLOW_DURATION_MS } from '../../src/skills/movement/followPlayer.js';
import { DefendSkill, DEFAULT_DEFEND_DURATION_MS } from '../../src/skills/survival/defend.js';
import { FakeMinecraftFacade } from './fakes/fakeFacade.js';
import { createTestContext } from './helpers/testContext.js';

function worldWithAlice(at = { x: 10, y: 64, z: 0 }): FakeMinecraftFacade {
  return new FakeMinecraftFacade({
    position: { x: 0, y: 64, z: 0 },
    players: [{ name: 'Alice', distance: 10, position: at, authorized: true }],
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FollowPlayerSkill - bounded', () => {
  it('ends by itself when the requested time is up', async () => {
    const facade = worldWithAlice();
    const skill = new FollowPlayerSkill(facade, 10);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Alice', durationMs: 60 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/followed alice/i);
    expect(facade.stopMovingCount).toBeGreaterThan(0);
  });

  it('has a bounded default, so a follow without a duration still ends', async () => {
    expect(DEFAULT_FOLLOW_DURATION_MS).toBeGreaterThan(0);
    expect(DEFAULT_FOLLOW_DURATION_MS).toBeLessThanOrEqual(10 * 60_000);

    vi.useFakeTimers();
    const facade = worldWithAlice();
    const skill = new FollowPlayerSkill(facade, 1_000);
    const test = createTestContext();

    const running = skill.execute({ player: 'Alice' }, test.ctx);
    await vi.advanceTimersByTimeAsync(DEFAULT_FOLLOW_DURATION_MS + 5_000);

    const result = await running;
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/followed alice/i);
  });

  it('is still cancellable while it runs', async () => {
    const facade = worldWithAlice();
    facade.moveDelayMs = 5;
    const skill = new FollowPlayerSkill(facade, 20);
    const test = createTestContext();

    const running = skill.execute({ player: 'Alice', durationMs: 60_000 }, test.ctx);
    setTimeout(() => test.abort(), 30);

    const result = await running;

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/stopped following/i);
  });
});

describe('DefendSkill - bounded', () => {
  it('has a bounded default, so a guard without a duration still ends', async () => {
    expect(DEFAULT_DEFEND_DURATION_MS).toBeGreaterThan(0);
    expect(DEFAULT_DEFEND_DURATION_MS).toBeLessThanOrEqual(5 * 60_000);

    vi.useFakeTimers();
    const facade = worldWithAlice({ x: 1, y: 64, z: 0 });
    const skill = new DefendSkill(facade);
    const test = createTestContext();

    const running = skill.execute({ player: 'Alice' }, test.ctx);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEFEND_DURATION_MS + 5_000);

    const result = await running;
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/guarded alice/i);
  });
});

describe('the continuous skills do not spam chat', () => {
  it('says once that it cannot see the player', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new FollowPlayerSkill(facade, 10);
    const test = createTestContext();

    await skill.execute({ player: 'Ghost' }, test.ctx);

    const spoken = test.messages.filter((message) => message.includes("can't see"));
    expect(spoken).toHaveLength(1);
  });

  it('says once that it cannot see the player while guarding', async () => {
    // Fake timers make the tick count exact: the guard ticks every 500ms, so
    // a 700ms guard runs exactly two ticks. The old version used the wall
    // clock, and on a slow machine only one tick happened - which made the
    // assertion below pass without the chat gate ever being challenged.
    vi.useFakeTimers();
    const facade = new FakeMinecraftFacade();
    const skill = new DefendSkill(facade);
    const test = createTestContext();

    const running = skill.execute({ player: 'Ghost', durationMs: 700 }, test.ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await running;

    const spoken = test.messages.filter((message) => message.includes("can't see"));
    expect(spoken).toHaveLength(1);
    // The guard really did look for the player more than once, so the single
    // message is the chat gate doing its job.
    expect(facade.stopMovingCount).toBeGreaterThan(1);
    expect(result.ok).toBe(true);
  });
});

describe('the escape reflex is wired in', () => {
  it('moves the bot away from lava while following', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'lava', at: { x: 1, y: 64, z: 0 } }],
      players: [{ name: 'Alice', distance: 10, position: { x: 10, y: 64, z: 0 }, authorized: true }],
    });
    const skill = new FollowPlayerSkill(facade, 10);
    const test = createTestContext();

    await skill.execute({ player: 'Alice', durationMs: 60 }, test.ctx);

    // The escape step goes away from the lava, i.e. towards negative x.
    expect(facade.moveToPositionCalls.some((call) => call.target.x < 0)).toBe(true);
  });

  it('moves the bot away from lava while guarding', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'lava', at: { x: 1, y: 64, z: 0 } }],
      players: [{ name: 'Alice', distance: 10, position: { x: 10, y: 64, z: 0 }, authorized: true }],
    });
    const skill = new DefendSkill(facade);
    const test = createTestContext();

    await skill.execute({ player: 'Alice', durationMs: 600 }, test.ctx);

    expect(facade.moveToPositionCalls.some((call) => call.target.x < 0)).toBe(true);
  });
});
