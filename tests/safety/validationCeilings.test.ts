/**
 * Validation and execution must agree.
 *
 * A plan that passes validation but is refused at execution is a plan the
 * player cannot trust: the bot says "I will do that" and then does not. The
 * ceilings therefore come from ONE place, and the anti-grief rules have to be
 * reachable from the chest helpers as well as from the executor.
 */
import { describe, expect, it } from 'vitest';
import { validateAction } from '../../src/executor/validator.js';
import {
  ActionLimits,
  DEFAULT_MAX_WAIT_MS,
  MAX_DEFEND_DURATION_MS,
  MAX_DROP_COUNT,
  MAX_FOLLOW_DURATION_MS,
} from '../../src/safety/actionLimits.js';
import { AntiGriefRules } from '../../src/safety/antiGrief.js';
import type { SafetyConfig } from '../../src/config/config.js';

function safety(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    maxActionsPerMinute: 30,
    maxMiningBlocksPerTask: 32,
    maxBuildBlocksPerTask: 16,
    followDistance: 3,
    ...overrides,
  };
}

describe('the validator and the executor share their ceilings', () => {
  it('agree on the longest wait', () => {
    const limits = new ActionLimits(safety());

    expect(validateAction({ type: 'wait', durationMs: DEFAULT_MAX_WAIT_MS }).valid).toBe(true);
    expect(limits.checkAction({ type: 'wait', durationMs: DEFAULT_MAX_WAIT_MS }).allowed).toBe(true);

    const tooLong = DEFAULT_MAX_WAIT_MS + 1;
    expect(validateAction({ type: 'wait', durationMs: tooLong }).valid).toBe(false);
    expect(limits.checkAction({ type: 'wait', durationMs: tooLong }).allowed).toBe(false);
  });

  it('agree on the biggest drop', () => {
    const limits = new ActionLimits(safety());

    expect(validateAction({ type: 'drop_item', item: 'dirt', count: MAX_DROP_COUNT }).valid).toBe(true);
    expect(limits.checkAction({ type: 'drop_item', count: MAX_DROP_COUNT }).allowed).toBe(true);

    const tooMany = MAX_DROP_COUNT + 1;
    expect(validateAction({ type: 'drop_item', item: 'dirt', count: tooMany }).valid).toBe(false);
    expect(limits.checkAction({ type: 'drop_item', count: tooMany }).allowed).toBe(false);
  });

  it('agree on the longest guard and follow', () => {
    const limits = new ActionLimits(safety());

    expect(
      validateAction({ type: 'defend_player', player: 'Alice', durationMs: MAX_DEFEND_DURATION_MS }).valid,
    ).toBe(true);
    expect(
      limits.checkAction({ type: 'defend_player', durationMs: MAX_DEFEND_DURATION_MS }).allowed,
    ).toBe(true);
    expect(
      validateAction({ type: 'defend_player', player: 'Alice', durationMs: MAX_DEFEND_DURATION_MS + 1 }).valid,
    ).toBe(false);
    expect(
      limits.checkAction({ type: 'defend_player', durationMs: MAX_DEFEND_DURATION_MS + 1 }).allowed,
    ).toBe(false);

    expect(
      validateAction({ type: 'follow_player', player: 'Alice', durationMs: MAX_FOLLOW_DURATION_MS }).valid,
    ).toBe(true);
    expect(
      limits.checkAction({ type: 'follow_player', durationMs: MAX_FOLLOW_DURATION_MS }).allowed,
    ).toBe(true);
    expect(
      validateAction({ type: 'follow_player', player: 'Alice', durationMs: MAX_FOLLOW_DURATION_MS + 1 }).valid,
    ).toBe(false);
    expect(
      limits.checkAction({ type: 'follow_player', durationMs: MAX_FOLLOW_DURATION_MS + 1 }).allowed,
    ).toBe(false);
  });

  it('refuses a duration the executor would refuse', () => {
    const limits = new ActionLimits(safety());

    expect(validateAction({ type: 'defend_player', player: 'Alice', durationMs: 0 }).valid).toBe(false);
    expect(limits.checkAction({ type: 'defend_player', durationMs: 0 }).allowed).toBe(false);
  });
});

describe('the validator accepts the shapes players and models use', () => {
  it('normalises a human written item name', () => {
    const result = validateAction({ type: 'equip_item', item: 'Iron Pickaxe' });

    expect(result.valid).toBe(true);
    expect(result.action).toMatchObject({ item: 'iron_pickaxe' });
  });

  it('normalises a human written resource phrase', () => {
    const result = validateAction({ type: 'collect_resource', resource: 'Oak Logs', count: 2 });

    expect(result.valid).toBe(true);
    expect(result.action).toMatchObject({ resource: 'oak_logs', count: 2 });
  });

  it('still refuses an item name that is not one', () => {
    expect(validateAction({ type: 'equip_item', item: '../../etc/passwd' }).valid).toBe(false);
    expect(validateAction({ type: 'equip_item', item: 'iron; rm -rf /' }).valid).toBe(false);
    expect(validateAction({ type: 'equip_item', item: '/op Alice' }).valid).toBe(false);
  });
});

describe('the validator refuses a chat line the server would run', () => {
  it('rejects a say message that starts with a slash', () => {
    // A leading slash is a SERVER COMMAND, not chat: "/op @a" would be
    // executed by the server the moment the bot sends it.
    expect(validateAction({ type: 'say', message: '/op @a' }).valid).toBe(false);
    expect(validateAction({ type: 'say', message: '/login hunter2' }).valid).toBe(false);
    expect(validateAction({ type: 'say', message: '\\op' }).valid).toBe(false);
  });

  it('still allows an ordinary chat line', () => {
    const result = validateAction({ type: 'say', message: 'Done! I mined 16 oak logs.' });

    expect(result.valid).toBe(true);
    expect(result.action).toMatchObject({ message: 'Done! I mined 16 oak logs.' });
  });
});

describe('ActionLimits - the remaining budget', () => {
  it('reports what is left of the per-task budget', () => {
    const limits = new ActionLimits(safety({ maxMiningBlocksPerTask: 10, maxBuildBlocksPerTask: 4 }));

    expect(limits.remainingMining()).toBe(10);
    expect(limits.remainingBuilding()).toBe(4);

    limits.recordMining(6);
    limits.recordBuilding(2);

    expect(limits.remainingMining()).toBe(4);
    expect(limits.remainingBuilding()).toBe(2);
    expect(limits.miningCeiling()).toBe(10);
    expect(limits.buildingCeiling()).toBe(4);
  });
});

describe('AntiGriefRules - chests', () => {
  const rules = new AntiGriefRules();
  const AT = { x: 10, y: 64, z: -5 };
  const context = { playerContainers: new Set(['10,64,-5']) };

  it('may read a player-owned chest', () => {
    const result = rules.canOpenChest(AT, context, 'read');

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('player-owned chest');
  });

  it('may not fill a player-owned chest', () => {
    const result = rules.canOpenChest(AT, context, 'write');

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/player-owned chest/i);
  });

  it('may write to a chest nobody owns', () => {
    expect(rules.canOpenChest(AT, { playerContainers: new Set() }, 'write').allowed).toBe(true);
  });
});
