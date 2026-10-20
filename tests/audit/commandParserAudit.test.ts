/**
 * Audit of the deterministic command parser (`src/chat/commandParser.ts`).
 *
 * The parser is the trust boundary for chat that never reaches an LLM, so
 * every value it turns into an action must be a value the shared executor
 * (`src/executor/validator.ts` + `src/safety/actionLimits.ts`) accepts as-is.
 * These tests pin that invariant and cover the three defects found:
 *
 *  - F1 `!goto` accepted coordinates outside the world border;
 *  - F2 `!drop` accepted a count above the shared drop ceiling;
 *  - F3 `!follow` accepted a distance that was never range checked.
 */
import { describe, expect, it } from 'vitest';
import type { BotAction } from '../../src/types/actions.js';
import {
  parseInput,
  toAction,
} from '../../src/chat/commandParser.js';
import { validateAction } from '../../src/executor/validator.js';
import { MAX_DROP_COUNT } from '../../src/safety/actionLimits.js';

/** Narrows the `{error}` result shape away so assertions can read the action. */
function action(name: string, args: string[]): BotAction {
  const result = toAction(name, args);
  if ('error' in result) {
    throw new Error(`expected "${name}" to parse, got error: ${result.error}`);
  }
  return result;
}

/** Asserts the conversion failed and returns the error text. */
function error(name: string, args: string[]): string {
  const result = toAction(name, args);
  if (!('error' in result)) {
    throw new Error(`expected "${name}" to fail, got: ${JSON.stringify(result)}`);
  }
  return result.error;
}

describe('F1 - !goto fails closed on coordinates outside the world border', () => {
  it('rejects a horizontal coordinate beyond the border', () => {
    // The validator and the executor both refuse this with "position is
    // outside the world border"; the parser must not build the action at all.
    expect(error('goto', ['30000001', '64', '0'])).toContain('world border');
    expect(error('goto', ['0', '64', '-30000001'])).toContain('world border');
  });

  it('rejects a vertical coordinate beyond the limit the executor enforces', () => {
    expect(error('goto', ['0', '20000001', '0'])).toContain('world border');
  });

  it('rejects an absurd coordinate instead of passing it on', () => {
    expect(error('goto', ['999999999999', '64', '0'])).toContain('world border');
  });

  it('still accepts a coordinate exactly on the border', () => {
    expect(action('goto', ['30000000', '64', '-30000000'])).toEqual({
      type: 'move_to_position',
      position: { x: 30_000_000, y: 64, z: -30_000_000 },
    });
  });

  it('never emits a position the shared validator refuses', () => {
    for (const args of [
      ['999999999999', '64', '0'],
      ['30000001', '64', '0'],
      ['0', '20000001', '0'],
      ['0', '20000000', '0'],
    ]) {
      const result = toAction('goto', args);
      if ('error' in result) continue;
      expect(validateAction(result).valid, args.join(' ')).toBe(true);
    }
  });
});

describe('F2 - !drop uses the shared drop ceiling', () => {
  it('accepts a count at the ceiling', () => {
    expect(action('drop', ['dirt', String(MAX_DROP_COUNT)])).toEqual({
      type: 'drop_item',
      item: 'dirt',
      count: MAX_DROP_COUNT,
    });
  });

  it('rejects a count above the ceiling', () => {
    // MAX_DROP_COUNT is one stack: the validator and the executor refuse
    // anything bigger, so such a request could never run.
    expect(error('drop', ['dirt', String(MAX_DROP_COUNT + 1)])).toContain('positive integer');
    expect(error('drop', ['dirt', '2304'])).toContain('positive integer');
  });

  it('still drops a whole stack', () => {
    expect(action('drop', ['dirt', '64']).type).toBe('drop_item');
  });

  it('never emits a drop the shared validator refuses', () => {
    for (const count of ['1', '32', '64', '65', '100', '512', '2304', '999999999999']) {
      const result = toAction('drop', ['dirt', count]);
      if ('error' in result) continue;
      expect(validateAction(result).valid, count).toBe(true);
    }
  });
});

describe('F3 - the follow distance is range checked', () => {
  it('rejects a malformed distance instead of dropping it in silence', () => {
    expect(error('follow', ['Alice', 'abc'])).toContain('usage: !follow');
    expect(error('follow', ['Alice', '1e3'])).toContain('usage: !follow');
  });

  it('rejects an absurd distance', () => {
    expect(error('follow', ['Alice', '999999999999'])).toContain('distance');
  });

  it('keeps the documented fallback for a non-positive distance', () => {
    expect(action('follow', ['Alice', '0'])).toEqual({ type: 'follow_player', player: 'Alice' });
    expect(action('follow', ['Alice', '-2'])).toEqual({ type: 'follow_player', player: 'Alice' });
  });

  it('keeps a sane distance', () => {
    expect(action('follow', ['Alice', '5'])).toEqual({
      type: 'follow_player',
      player: 'Alice',
      distance: 5,
    });
    expect(action('follow', ['Alice', '64'])).toEqual({
      type: 'follow_player',
      player: 'Alice',
      distance: 64,
    });
  });
});

describe('the parser only emits actions the shared validator accepts', () => {
  it('holds for every deterministic command with its own arguments', () => {
    // `come` is excluded on purpose: it carries a placeholder player name
    // that the caller fills in (see `src/index.ts`).
    const samples: Array<[string, string[]]> = [
      ['goto', ['10', '64', '-5']],
      ['goto', ['0', '0', '0']],
      ['follow', ['Alice']],
      ['follow', ['Alice', '5']],
      ['guard', ['Alice']],
      ['stop', []],
      ['stay', []],
      ['eat', []],
      ['eat', ['golden_apple']],
      ['equip', ['diamond_pickaxe']],
      ['drop', ['dirt']],
      ['drop', ['dirt', '64']],
      ['mine', ['oak_log']],
      ['mine', ['oak_log', '512']],
      ['deposit', []],
      ['deposit', ['cobblestone']],
      ['withdraw', []],
      ['withdraw', ['cobblestone', '2304']],
      ['pickup', []],
      ['pickup', ['dirt', '64']],
    ];
    for (const [name, args] of samples) {
      const result = toAction(name, args);
      if ('error' in result) {
        throw new Error(`expected "${name}" to parse, got error: ${result.error}`);
      }
      const validation = validateAction(result);
      expect(validation.valid, `${name} ${args.join(' ')}: ${validation.reason ?? ''}`).toBe(true);
    }
  });
});

describe('parseInput - the prefix is still matched exactly', () => {
  it('treats a lookalike or doubled prefix as plain chat', () => {
    for (const message of ['!!stop', '!\uFF01stop', '!stop!', '!stop;', '!\u0000stop']) {
      const result = parseInput(message, '!');
      expect(result.kind, message).toBe('chat');
      expect(result.command, message).toBeUndefined();
    }
  });

  it('still recognises a command after the prefix', () => {
    const result = parseInput('!   GoTo    1   2   3', '!');
    expect(result.kind).toBe('command');
    expect(result.command?.name).toBe('goto');
    expect(result.command?.args).toEqual(['1', '2', '3']);
  });
});
