import { describe, expect, it } from 'vitest';
import { FollowPlayerSkill } from '../../src/skills/movement/followPlayer.js';
import { createTestContext } from './helpers/testContext.js';
import { FakeMinecraftFacade } from './fakes/fakeFacade.js';

function worldWithAlice(): FakeMinecraftFacade {
  return new FakeMinecraftFacade({
    position: { x: 0, y: 64, z: 0 },
    players: [{ name: 'Alice', distance: 10, position: { x: 10, y: 64, z: 0 }, authorized: true }],
  });
}

describe('FollowPlayerSkill', () => {
  it('stops promptly when the task is aborted mid-follow', async () => {
    const facade = worldWithAlice();
    facade.moveDelayMs = 5;
    const skill = new FollowPlayerSkill(facade, 20);
    const test = createTestContext();

    const running = skill.execute({ player: 'Alice', distance: 3 }, test.ctx);
    setTimeout(() => test.abort(), 30);

    const result = await running;

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Stopped following/i);
    // Cleanup: the bot must not be left walking.
    expect(facade.stopMovingCount).toBeGreaterThan(0);
    expect(facade.getGoal()).toBeNull();
  });

  it('passes the abort signal into the facade navigation call', async () => {
    const facade = worldWithAlice();
    const skill = new FollowPlayerSkill(facade, 20);
    const test = createTestContext();

    const running = skill.execute({ player: 'Alice', distance: 3 }, test.ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    test.abort();
    await running;

    const call = facade.moveToPlayerCalls[0];
    expect(call).toBeDefined();
    expect(call?.options?.signal).toBeDefined();
    expect(call?.options?.arriveDistance).toBeGreaterThanOrEqual(2);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const facade = worldWithAlice();
    const skill = new FollowPlayerSkill(facade, 20);
    const test = createTestContext();
    test.abort();

    const result = await skill.execute({ player: 'Alice' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.moveToPlayerCalls).toHaveLength(0);
    expect(facade.stopMovingCount).toBe(1);
  });

  it('stops without ever standing inside the player', async () => {
    const facade = worldWithAlice();
    facade.movePlayer('Alice', { x: 1, y: 64, z: 0 });
    const skill = new FollowPlayerSkill(facade, 15);
    const test = createTestContext();

    const running = skill.execute({ player: 'Alice', distance: 0 }, test.ctx);
    await new Promise((resolve) => setTimeout(resolve, 40));
    test.abort();
    await running;

    // A request for 0 distance is clamped to the safe minimum, so the bot
    // never walks onto the player.
    const distances = facade.moveToPlayerCalls.map((c) => c.options?.arriveDistance ?? 0);
    expect(distances.every((d) => d >= 2)).toBe(true);
    expect(distanceTo(facade, facade.getNearestPlayer('Alice')?.position)).toBeGreaterThan(1);
  });

  it('gives up when the player cannot be found', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new FollowPlayerSkill(facade, 10);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Ghost' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/lost sight/i);
  });
});

function distanceTo(facade: FakeMinecraftFacade, other?: { x: number; y: number; z: number }): number {
  if (!other) return Number.POSITIVE_INFINITY;
  const here = facade.getPosition();
  return Math.hypot(here.x - other.x, here.y - other.y, here.z - other.z);
}