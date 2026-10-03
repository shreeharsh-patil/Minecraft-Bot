import { describe, expect, it } from 'vitest';
import { ACTION_TYPES } from '../../src/types/actions.js';
import type { ActionType } from '../../src/types/actions.js';
import { conflictGroupsFor, createSkillRegistry, getSkill } from '../../src/skills/index.js';
import { FakeMinecraftFacade } from './fakes/fakeFacade.js';

describe('skill registry', () => {
  const facade = new FakeMinecraftFacade();
  const registry = createSkillRegistry(facade);

  it('has a skill for every action type', () => {
    for (const type of ACTION_TYPES) {
      expect(getSkill(registry, type), `missing skill for ${type}`).toBeDefined();
    }
    expect(registry.size).toBe(ACTION_TYPES.length);
  });

  it('registers each skill under its own name', () => {
    for (const [type, skill] of registry) {
      expect(skill.name).toBe(type);
    }
  });

  it('declares conflict groups for every skill', () => {
    for (const type of ACTION_TYPES) {
      const groups = conflictGroupsFor(registry, type);
      expect(groups.length, `no conflict group for ${type}`).toBeGreaterThan(0);
      for (const group of groups) {
        expect(['movement', 'mining', 'building', 'inventory', 'combat', 'none']).toContain(group);
      }
    }
  });

  it('puts movement skills in the movement group', () => {
    const movementTypes: ActionType[] = ['move_to_player', 'move_to_position', 'follow_player'];
    for (const type of movementTypes) {
      expect(conflictGroupsFor(registry, type)).toContain('movement');
    }
  });

  it('puts mining and building in their own groups', () => {
    expect(conflictGroupsFor(registry, 'mine_block')).toContain('mining');
    expect(conflictGroupsFor(registry, 'collect_resource')).toContain('mining');
    expect(conflictGroupsFor(registry, 'place_block')).toContain('building');
    expect(conflictGroupsFor(registry, 'build_structure')).toContain('building');
  });

  it('runs a skill straight from the registry', async () => {
    const stop = getSkill(registry, 'stop');
    expect(stop).toBeDefined();
    const result = await stop!.execute({} as never, {
      task: {} as never,
      signal: new AbortController().signal,
      progress: () => undefined,
      say: () => undefined,
    });
    expect(result.ok).toBe(true);
  });
});