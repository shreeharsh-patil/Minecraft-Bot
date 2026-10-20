import { describe, expect, it } from 'vitest';
import type { Skill } from '../../src/types/skill.js';
import { MOVEMENT } from '../../src/config/constants.js';
import { distance3 } from '../../src/types/world.js';
import { GotoPlayerSkill } from '../../src/skills/movement/gotoPlayer.js';
import { GotoPositionSkill } from '../../src/skills/movement/gotoPosition.js';
import { StopSkill } from '../../src/skills/basic/stop.js';
import { WaitSkill } from '../../src/skills/basic/wait.js';
import { LookAtSkill } from '../../src/skills/basic/lookAt.js';
import { FakeMinecraftFacade } from './fakes/fakeFacade.js';
import { createTestContext } from './helpers/testContext.js';

function worldWithAlice(at = { x: 10, y: 64, z: 0 }): FakeMinecraftFacade {
  return new FakeMinecraftFacade({
    position: { x: 0, y: 64, z: 0 },
    players: [{ name: 'Alice', distance: 10, position: at, authorized: true }],
  });
}

describe('GotoPlayerSkill', () => {
  it('walks to the player and stops short', async () => {
    const facade = worldWithAlice();
    const skill = new GotoPlayerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Alice' }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.moveToPlayerCalls).toHaveLength(1);
    expect(facade.getPosition().x).toBeGreaterThan(7);
    expect(facade.getPosition().x).toBeLessThan(10);
  });

  it('reports an unknown player without moving', async () => {
    const facade = worldWithAlice();
    const skill = new GotoPlayerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Nobody' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/can't find Nobody/i);
    expect(facade.moveToPlayerCalls).toHaveLength(0);
  });

  it('reports an unreachable player', async () => {
    const facade = worldWithAlice();
    facade.pathfindingFails = true;
    const skill = new GotoPlayerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Alice' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/can't find a path/i);
  });

  it('does nothing when already aborted', async () => {
    const facade = worldWithAlice();
    const skill = new GotoPlayerSkill(facade);
    const test = createTestContext();
    test.abort();

    const result = await skill.execute({ player: 'Alice' }, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.moveToPlayerCalls).toHaveLength(0);
  });
});

describe('GotoPositionSkill', () => {
  it('walks to the requested coordinates', async () => {
    const facade = new FakeMinecraftFacade({ position: { x: 0, y: 64, z: 0 } });
    const skill = new GotoPositionSkill(facade);
    const test = createTestContext();
    const target = { x: 8, y: 64, z: -3 };

    const result = await skill.execute({ position: target }, test.ctx);

    expect(result.ok).toBe(true);
    // The skill must ask for exactly those coordinates...
    expect(facade.moveToPositionCalls[0]?.target).toEqual(target);
    // ...and the bot ends up there. The real pathfinder stops `arriveDistance`
    // short of the target, so the contract is "within reach", not "on the
    // exact block".
    expect(distance3(facade.getPosition(), target)).toBeLessThanOrEqual(MOVEMENT.ARRIVE_DISTANCE + 1);
  });

  it('rejects invalid coordinates', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new GotoPositionSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ position: { x: Number.NaN, y: 0, z: 0 } }, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not valid coordinates/i);
  });
});

describe('basic skills', () => {
  it('stop halts movement', async () => {
    const facade = new FakeMinecraftFacade();
    // Typed through the Skill interface: that is how the executor calls it.
    const skill: Skill<Record<string, never>> = new StopSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.stopMovingCount).toBe(1);
  });

  it('wait honours an abort fired while sleeping', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new WaitSkill(facade);
    const test = createTestContext();

    const running = skill.execute({ durationMs: 5_000 }, test.ctx);
    setTimeout(() => test.abort(), 20);

    const result = await running;

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Stopped waiting/i);
  });

  it('wait clamps a silly duration', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new WaitSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ durationMs: -50 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/No need to wait/i);
  });

  it('look_at turns towards the position', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new LookAtSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ position: { x: 5, y: 65, z: 5 }, durationMs: 0 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.lookTargets).toHaveLength(1);
  });
});