/**
 * Audit of the follow_player skill (`src/skills/movement/followPlayer.ts`).
 *
 * The first test is the regression test for the defect the audit found: the
 * escape reflex moved the bot but left the follow plan in place, so the bot
 * never closed in on the player again. It fails without the fix.
 *
 * The remaining tests lock in the behaviour the audit verified as correct
 * (the distance band, the back-off direction, the bounded duration, the chat
 * rate limit and the cancellation path) so a later change cannot quietly
 * invert or drop them.
 */
import { describe, expect, it } from 'vitest';
import { FollowPlayerSkill } from '../../src/skills/movement/followPlayer.js';
import { MOVEMENT } from '../../src/config/constants.js';
import { createTestContext } from '../skills/helpers/testContext.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';

/** Polls until `predicate` holds; false when the timeout expires. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function worldWithAlice(
  options: { aliceAt?: { x: number; y: number; z: number }; lavaAt?: { x: number; y: number; z: number } } = {},
): FakeMinecraftFacade {
  const aliceAt = options.aliceAt ?? { x: 10, y: 64, z: 0 };
  return new FakeMinecraftFacade({
    position: { x: 0, y: 64, z: 0 },
    players: [{ name: 'Alice', distance: 10, position: aliceAt, authorized: true }],
    ...(options.lavaAt ? { blocks: [{ name: 'lava', at: options.lavaAt }] } : {}),
  });
}

describe('FollowPlayerSkill - the escape reflex must not end the follow', () => {
  it('re-plans the route to the player after the escape moved the bot', async () => {
    // The lava sits one block short of where the bot stops next to the
    // player, so the escape reflex fires on the second tick and throws the
    // bot six blocks away from its route.
    const facade = worldWithAlice({ lavaAt: { x: 9, y: 64, z: 0 } });
    const skill = new FollowPlayerSkill(facade, 50);
    const test = createTestContext();

    const running = skill.execute({ player: 'Alice', durationMs: 5_000 }, test.ctx);
    const replanned = await waitFor(() => facade.moveToPlayerCalls.length >= 2, 2_000);
    test.abort();
    await running;

    // The escape still happens - the reflex is not weakened.
    expect(facade.moveToPositionCalls.some((call) => call.target.x < 8)).toBe(true);
    // ... but the follow continues: a fresh route to the player is planned
    // once the bot is out of the lava.
    expect(replanned).toBe(true);
    expect(facade.moveToPlayerCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('FollowPlayerSkill - the distance band', () => {
  it('closes in when the player is beyond the band', async () => {
    const facade = worldWithAlice({ aliceAt: { x: 20, y: 64, z: 0 } });
    const skill = new FollowPlayerSkill(facade, 50);
    const test = createTestContext();

    const running = skill.execute({ player: 'Alice', durationMs: 5_000 }, test.ctx);
    await waitFor(() => facade.moveToPlayerCalls.length >= 1, 2_000);
    test.abort();
    await running;

    // Too far: the bot walks towards the player, it does not back off.
    expect(facade.moveToPlayerCalls.length).toBeGreaterThanOrEqual(1);
    expect(facade.getPosition().x).toBeGreaterThan(15);
  });

  it('holds the band instead of chasing a player that is already close', async () => {
    // The band is [MIN_FOLLOW_DISTANCE, distance]: with a requested distance
    // of 12 the bot is happy anywhere between 2 and 12 blocks.
    const facade = worldWithAlice({ aliceAt: { x: 5, y: 64, z: 0 } });
    const skill = new FollowPlayerSkill(facade, 50);
    const test = createTestContext();

    const running = skill.execute({ player: 'Alice', distance: 12, durationMs: 300 }, test.ctx);
    await new Promise((resolve) => setTimeout(resolve, 150));
    test.abort();
    await running;

    // Inside the band: no walking towards the player at all.
    expect(facade.moveToPlayerCalls).toHaveLength(0);
    expect(facade.getPosition().x).toBe(0);
  });

  it('steps AWAY from the player when the bot is too close', async () => {
    const facade = worldWithAlice({ aliceAt: { x: 1, y: 64, z: 0 } });
    const skill = new FollowPlayerSkill(facade, 50);
    const test = createTestContext();

    const running = skill.execute({ player: 'Alice', durationMs: 5_000 }, test.ctx);
    await waitFor(() => facade.moveToPositionCalls.length >= 1, 2_000);
    test.abort();
    await running;

    // The back-off target has to be on the far side of the bot from the
    // player (the player is at x=1), never towards them.
    const backOff = facade.moveToPositionCalls[0];
    expect(backOff).toBeDefined();
    expect(backOff?.target.x).toBeLessThan(1);
    expect(facade.getPosition().x).toBeLessThan(1);
  });
});

describe('FollowPlayerSkill - bounded and polite', () => {
  it('ends on its own when the requested duration is up', async () => {
    const facade = worldWithAlice();
    const skill = new FollowPlayerSkill(facade, 20);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Alice', durationMs: 120 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/Followed Alice/i);
    expect(facade.stopMovingCount).toBeGreaterThan(0);
  });

  it('never starts a navigation that outlives the follow itself', async () => {
    const facade = worldWithAlice();
    const skill = new FollowPlayerSkill(facade, 20);
    const test = createTestContext();

    await skill.execute({ player: 'Alice', durationMs: 1_000 }, test.ctx);

    // A pathing attempt may take up to MOVEMENT.PATH_TIMEOUT_MS, but never
    // longer than the follow has left: otherwise a follow that is nearly
    // over still holds the movement conflict group for a whole path.
    const budget = facade.moveToPlayerCalls[0]?.options?.timeoutMs;
    expect(budget).toBeDefined();
    expect(budget).toBeLessThanOrEqual(1_000);
    expect(budget).toBeLessThan(MOVEMENT.PATH_TIMEOUT_MS);
  });

  it('says one line when it cannot see the player, not one per tick', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new FollowPlayerSkill(facade, 20);
    const test = createTestContext();

    await skill.execute({ player: 'Ghost' }, test.ctx);

    expect(test.messages.filter((message) => message.includes("can't see"))).toHaveLength(1);
  });

  it('stops promptly and leaves the bot standing still when cancelled', async () => {
    const facade = worldWithAlice();
    const skill = new FollowPlayerSkill(facade, 50);
    const test = createTestContext();

    const running = skill.execute({ player: 'Alice', durationMs: 5_000 }, test.ctx);
    setTimeout(() => test.abort(), 30);
    const result = await running;

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Stopped following/i);
    expect(facade.stopMovingCount).toBeGreaterThan(0);
    expect(facade.getGoal()).toBeNull();
  });
});
