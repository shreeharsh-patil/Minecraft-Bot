import { describe, expect, it } from 'vitest';
import { AutoEatSkill } from '../../src/skills/survival/autoEat.js';
import { EscapeDangerSkill, detectDanger } from '../../src/skills/survival/escapeDanger.js';
import { DefendSkill } from '../../src/skills/survival/defend.js';
import { AttackHostileSkill } from '../../src/skills/combat/attackHostile.js';
import { FakeMinecraftFacade } from './fakes/fakeFacade.js';
import { createTestContext } from './helpers/testContext.js';

describe('AutoEatSkill', () => {
  it('eats the best food carried when hungry', async () => {
    const facade = new FakeMinecraftFacade({ hunger: 8, inventory: { bread: 3, golden_carrot: 1 } });
    const skill = new AutoEatSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(facade.countItem('golden_carrot')).toBe(0);
    expect(facade.getHunger().current).toBeGreaterThan(8);
  });

  it('does nothing when not hungry', async () => {
    const facade = new FakeMinecraftFacade({ hunger: 20, inventory: { bread: 3 } });
    const skill = new AutoEatSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.calls).not.toContain('eat');
  });

  it('reports when hungry with no food', async () => {
    const facade = new FakeMinecraftFacade({ hunger: 5, inventory: {} });
    const skill = new AutoEatSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no food/i);
  });
});

describe('EscapeDangerSkill', () => {
  it('detects nearby hazards', () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [
        { name: 'lava', at: { x: 2, y: 64, z: 0 } },
        { name: 'stone', at: { x: -3, y: 64, z: 0 } },
      ],
    });

    const report = detectDanger(facade, 6);

    expect(report.hazardousBlocks).toHaveLength(1);
    expect(report.hazardousBlocks[0]?.name).toBe('lava');
  });

  it('moves away from lava', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'lava', at: { x: 4, y: 64, z: 0 } }],
    });
    const skill = new EscapeDangerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(true);
    expect(facade.getPosition().x).toBeLessThan(0);
  });

  it('does nothing when there is no danger', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new EscapeDangerSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/Nothing dangerous/i);
    expect(facade.moveToPositionCalls).toHaveLength(0);
  });
});

describe('DefendSkill', () => {
  it('stays near the player and stops on abort', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 1, y: 64, z: 0 },
      players: [{ name: 'Alice', distance: 1, position: { x: 0, y: 64, z: 0 }, authorized: true }],
    });
    const skill = new DefendSkill(facade);
    const test = createTestContext();

    const running = skill.execute({ player: 'Alice', durationMs: 60_000 }, test.ctx);
    setTimeout(() => test.abort(), 60);

    const result = await running;

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Stopped guarding/i);
    expect(facade.stopMovingCount).toBeGreaterThan(0);
    expect(facade.getGoal()).toBeNull();
  });

  it('finishes cleanly when the duration elapses', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 1, y: 64, z: 0 },
      players: [{ name: 'Alice', distance: 1, position: { x: 0, y: 64, z: 0 }, authorized: true }],
    });
    const skill = new DefendSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({ player: 'Alice', durationMs: 0 }, test.ctx);

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/Guarded Alice/);
  });
});

describe('AttackHostileSkill', () => {
  it('reports when there is nothing to fight', async () => {
    const facade = new FakeMinecraftFacade();
    const skill = new AttackHostileSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no hostile mobs nearby/i);
  });

  it('swing at a hostile that is in range', async () => {
    const facade = new FakeMinecraftFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [{ name: 'zombie', type: 'hostile', distance: 2, position: { x: 2, y: 64, z: 0 } }],
    });
    const skill = new AttackHostileSkill(facade);
    const test = createTestContext();

    const running = skill.execute({}, test.ctx);
    await new Promise((resolve) => setTimeout(resolve, 40));
    test.abort();
    const result = await running;

    expect(facade.lookTargets.length).toBeGreaterThan(0);
    // The frozen EntitySummary has no id, so the skill swings rather than
    // inventing an entity id.
    expect(facade.calls).toContain('useItem');
    expect(result.count).toBeGreaterThan(0);
  });

  it('does not fight passive mobs', async () => {
    const facade = new FakeMinecraftFacade({
      entities: [{ name: 'cow', type: 'passive', distance: 2, position: { x: 2, y: 64, z: 0 } }],
    });
    const skill = new AttackHostileSkill(facade);
    const test = createTestContext();

    const result = await skill.execute({}, test.ctx);

    expect(result.ok).toBe(false);
    expect(facade.calls).not.toContain('useItem');
  });
});