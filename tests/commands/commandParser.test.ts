/**
 * Deterministic command parsing.
 *
 * These are the only chat lines that can produce an action without a model in
 * the loop, so the parser is a trust boundary: hostile arguments (path
 * traversal, injection payloads, absurd coordinates) must fail closed here.
 */
import { describe, expect, it } from 'vitest';
import type { BotAction } from '../../src/types/actions.js';
import {
  DETERMINISTIC_COMMANDS,
  LOCAL_COMMANDS,
  parseCount,
  parseInput,
  parseInteger,
  parseIntegers,
  parseLocationName,
  parsePlayerName,
  toAction,
} from '../../src/chat/commandParser.js';

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

describe('parseInput - classification', () => {
  it('classifies a prefixed command', () => {
    const result = parseInput('!goto 10 64 -5', '!');

    expect(result.kind).toBe('command');
    expect(result.command?.name).toBe('goto');
    expect(result.command?.args).toEqual(['10', '64', '-5']);
    expect(result.command?.raw).toBe('goto 10 64 -5');
  });

  it('lower-cases the command name and collapses whitespace', () => {
    const result = parseInput('!   GoTo    1   2   3', '!');

    expect(result.kind).toBe('command');
    expect(result.command?.name).toBe('goto');
    expect(result.command?.args).toEqual(['1', '2', '3']);
  });

  it('classifies unprefixed text as plain chat', () => {
    const result = parseInput('can you chop some wood?', '!');

    expect(result.kind).toBe('chat');
    expect(result.text).toBe('can you chop some wood?');
    expect(result.command).toBeUndefined();
  });

  it('trims surrounding whitespace on chat', () => {
    expect(parseInput('  hello  ', '!').text).toBe('hello');
  });

  it('classifies empty and whitespace-only input as empty', () => {
    expect(parseInput('', '!').kind).toBe('empty');
    expect(parseInput('    ', '!').kind).toBe('empty');
    expect(parseInput('\t\n', '!').kind).toBe('empty');
  });

  it('classifies a bare prefix with no command as empty', () => {
    expect(parseInput('!', '!').kind).toBe('empty');
    expect(parseInput('!   ', '!').kind).toBe('empty');
  });

  it('treats a malformed prefix usage as chat, never as a command', () => {
    // Leading digit, symbol, and an oversized name all fail NAME_PATTERN.
    for (const message of ['!123', '!$$$', '!a'.repeat(30), '!!stop', '!<script>']) {
      const result = parseInput(message, '!');
      expect(result.kind).toBe('chat');
      expect(result.command).toBeUndefined();
    }
  });

  it('honours a custom prefix', () => {
    expect(parseInput('?stop', '?').kind).toBe('command');
    expect(parseInput('!stop', '?').kind).toBe('chat');
  });
});

describe('parseInput - command metadata', () => {
  it('reports a no-argument command with an empty arg list', () => {
    const result = parseInput('!stop', '!');

    expect(result.command).toEqual({ name: 'stop', args: [], raw: 'stop' });
  });

  it('accepts hyphens and digits in a command name', () => {
    const result = parseInput('!pick-up 3', '!');
    expect(result.command?.name).toBe('pick-up');
  });
});
describe('toAction - movement', () => {
  it('builds move_to_player for !come (player filled in by the caller)', () => {
    expect(action('come', [])).toEqual({ type: 'move_to_player', player: '' });
  });

  it('ignores stray arguments to !come', () => {
    expect(action('come', ['Bob', 'now'])).toEqual({ type: 'move_to_player', player: '' });
  });

  it('builds move_to_position for !goto', () => {
    expect(action('goto', ['10', '64', '-5'])).toEqual({
      type: 'move_to_position',
      position: { x: 10, y: 64, z: -5 },
    });
  });

  it('accepts negative and zero coordinates', () => {
    expect(action('goto', ['0', '-64', '0'])).toEqual({
      type: 'move_to_position',
      position: { x: 0, y: -64, z: 0 },
    });
  });

  it('builds follow_player, with an optional positive distance', () => {
    expect(action('follow', ['Alice'])).toEqual({ type: 'follow_player', player: 'Alice' });
    expect(action('follow', ['Alice', '5'])).toEqual({
      type: 'follow_player',
      player: 'Alice',
      distance: 5,
    });
  });

  it('drops a non-positive follow distance rather than trusting it', () => {
    expect(action('follow', ['Alice', '0'])).toEqual({ type: 'follow_player', player: 'Alice' });
    expect(action('follow', ['Alice', '-2'])).toEqual({ type: 'follow_player', player: 'Alice' });
  });

  it('builds defend_player with the fixed default radius', () => {
    expect(action('guard', ['Alice'])).toEqual({
      type: 'defend_player',
      player: 'Alice',
      radius: 8,
    });
  });

  it('builds stop for !stop', () => {
    expect(action('stop', [])).toEqual({ type: 'stop' });
    expect(action('stop', ['everything'])).toEqual({ type: 'stop' });
  });
});

describe('toAction - survival and inventory', () => {
  it('builds eat, with and without an item', () => {
    expect(action('eat', [])).toEqual({ type: 'eat' });
    expect(action('eat', ['golden_apple'])).toEqual({ type: 'eat', item: 'golden_apple' });
  });

  it('builds equip_item', () => {
    expect(action('equip', ['diamond_pickaxe'])).toEqual({
      type: 'equip_item',
      item: 'diamond_pickaxe',
    });
  });

  it('lower-cases item names', () => {
    expect(action('equip', ['Diamond_Pickaxe'])).toEqual({
      type: 'equip_item',
      item: 'diamond_pickaxe',
    });
  });

  it('builds drop_item with an optional count', () => {
    expect(action('drop', ['dirt'])).toEqual({ type: 'drop_item', item: 'dirt' });
    expect(action('drop', ['dirt', '12'])).toEqual({ type: 'drop_item', item: 'dirt', count: 12 });
  });

  it('builds mine_block, defaulting the count to 16', () => {
    expect(action('mine', ['oak_log'])).toEqual({
      type: 'mine_block',
      blockName: 'oak_log',
      count: 16,
    });
    expect(action('mine', ['oak_log', '32'])).toEqual({
      type: 'mine_block',
      blockName: 'oak_log',
      count: 32,
    });
  });

  it('builds deposit_items, with and without an item', () => {
    expect(action('deposit', [])).toEqual({ type: 'deposit_items' });
    expect(action('deposit', ['cobblestone'])).toEqual({
      type: 'deposit_items',
      item: 'cobblestone',
    });
  });

  it('builds withdraw_items with an item and count', () => {
    expect(action('withdraw', [])).toEqual({ type: 'withdraw_items' });
    expect(action('withdraw', ['cobblestone'])).toEqual({
      type: 'withdraw_items',
      item: 'cobblestone',
    });
    expect(action('withdraw', ['cobblestone', '64'])).toEqual({
      type: 'withdraw_items',
      item: 'cobblestone',
      count: 64,
    });
  });
});
describe('toAction - invalid arguments return { error }', () => {
  it('rejects malformed !goto coordinates', () => {
    expect(error('goto', ['1', '2'])).toContain('usage: !goto');
    expect(error('goto', [])).toContain('usage: !goto');
    expect(error('goto', ['1', '2', 'x'])).toContain('usage: !goto');
    expect(error('goto', ['1', '2', '3.5'])).toContain('usage: !goto');
    expect(error('goto', ['NaN', '64', '0'])).toContain('usage: !goto');
  });

  it('rejects a missing or malformed player name', () => {
    expect(error('follow', [])).toContain('usage: !follow');
    expect(error('follow', ['Alice Smith'])).toContain('usage: !follow');
    expect(error('follow', ['a'.repeat(17)])).toContain('usage: !follow');
    expect(error('guard', [])).toContain('usage: !guard');
    expect(error('guard', ['; rm -rf /'])).toContain('usage: !guard');
  });

  it('rejects zero, negative and non-numeric counts', () => {
    expect(error('drop', ['dirt', '0'])).toContain('positive integer');
    expect(error('drop', ['dirt', '-1'])).toContain('positive integer');
    expect(error('drop', ['dirt', 'lots'])).toContain('positive integer');
    expect(error('withdraw', ['dirt', '0'])).toContain('positive integer');
    expect(error('mine', ['dirt', '0'])).toContain('positive integer');
    expect(error('mine', ['dirt', '-5'])).toContain('positive integer');
  });

  it('caps a drop/withdraw count at a single stack', () => {
    expect(error('drop', ['dirt', '2305'])).toContain('positive integer');
    expect(error('withdraw', ['dirt', '99999'])).toContain('positive integer');
  });

  it('requires an item where one is mandatory', () => {
    expect(error('equip', [])).toContain('usage: !equip');
    expect(error('drop', [])).toContain('usage: !drop');
    expect(error('mine', [])).toContain('usage: !mine');
  });

  it('rejects an unknown command', () => {
    expect(error('teleport', ['0', '64', '0'])).toContain('unknown command');
    expect(error('', [])).toContain('unknown command');
  });
});

describe('toAction - hostile input is rejected', () => {
  it('rejects item names with path traversal', () => {
    for (const hostile of [
      '../../.env',
      '..\\..\\windows\\system32',
      '/etc/passwd',
      'dirt/../../secret',
      './dirt',
    ]) {
      expect(error('equip', [hostile])).toContain('usage: !equip');
      expect(error('drop', [hostile])).toContain('usage: !drop');
      expect(error('mine', [hostile])).toContain('usage: !mine');
    }
  });

  it('rejects item names carrying injection characters', () => {
    for (const hostile of [
      'dirt; rm -rf /',
      'dirt`whoami`',
      'dirt$(id)',
      'dirt|cat',
      '<script>alert(1)</script>',
      'dirt\u0000null',
      'dirt\nnewline',
      "dirt'quote",
    ]) {
      expect(error('mine', [hostile])).toContain('usage: !mine');
      expect(error('deposit', [hostile])).toContain('invalid item name');
    }
  });

  it('rejects coordinates that are NaN, Infinity or otherwise non-integer', () => {
    for (const bad of ['NaN', 'Infinity', '-Infinity', '1e3', '0x10', '1_000', '64.5', '+64']) {
      expect(error('goto', [bad, '64', '0'])).toContain('usage: !goto');
    }
  });

  it('rejects absurdly long coordinates', () => {
    expect(error('goto', ['9'.repeat(20), '64', '0'])).toContain('usage: !goto');
    expect(error('goto', ['0', '64', '1'.repeat(40)]).length).toBeGreaterThan(0);
  });

  it('rejects a count that overflows the safe integer range', () => {
    expect(parseCount('9'.repeat(20))).toBeNull();
    expect(parseCount('Infinity')).toBeNull();
  });
});
describe('parseInteger', () => {
  it('parses plain and negative integers', () => {
    expect(parseInteger('0')).toBe(0);
    expect(parseInteger('42')).toBe(42);
    expect(parseInteger('-7')).toBe(-7);
  });

  it('rejects anything that is not a plain integer literal', () => {
    for (const bad of [
      undefined,
      '',
      ' ',
      'abc',
      '1.5',
      '1e3',
      '0x10',
      '+1',
      '1,000',
      '--1',
      '1 ',
    ]) {
      expect(parseInteger(bad)).toBeNull();
    }
  });

  it('rejects integers beyond 12 digits', () => {
    expect(parseInteger('123456789012')).toBe(123456789012);
    expect(parseInteger('1234567890123')).toBeNull();
  });
});

describe('parseIntegers', () => {
  it('parses a coordinate triple', () => {
    expect(parseIntegers(['1', '2', '3'])).toEqual([1, 2, 3]);
  });

  it('returns null when any element is invalid or the list is empty', () => {
    expect(parseIntegers(['1', 'x', '3'])).toBeNull();
    expect(parseIntegers([])).toBeNull();
  });
});

describe('parsePlayerName', () => {
  it('accepts 1..16 alphanumerics and underscores', () => {
    expect(parsePlayerName('A')).toBe('A');
    expect(parsePlayerName('Alice_99')).toBe('Alice_99');
    expect(parsePlayerName('a'.repeat(16))).toBe('a'.repeat(16));
  });

  it('rejects empty, overlong and special-character names', () => {
    expect(parsePlayerName(undefined)).toBeNull();
    expect(parsePlayerName('')).toBeNull();
    expect(parsePlayerName('a'.repeat(17))).toBeNull();
    expect(parsePlayerName('Alice-2')).toBeNull();
    expect(parsePlayerName('Alice Smith')).toBeNull();
    expect(parsePlayerName('${whoami}')).toBeNull();
  });
});

describe('parseCount', () => {
  it('accepts positive counts within the cap', () => {
    expect(parseCount('1')).toBe(1);
    expect(parseCount('64')).toBe(64);
    expect(parseCount('10000')).toBe(10_000);
  });

  it('rejects zero, negatives and anything over the cap', () => {
    expect(parseCount('0')).toBeNull();
    expect(parseCount('-3')).toBeNull();
    expect(parseCount('10001')).toBeNull();
    expect(parseCount('64', 32)).toBeNull();
    expect(parseCount(undefined)).toBeNull();
  });
});

describe('parseLocationName', () => {
  it('lower-cases a valid named location', () => {
    expect(parseLocationName('Home')).toBe('home');
    expect(parseLocationName('mine_1')).toBe('mine_1');
  });

  it('rejects traversal and overlong location names', () => {
    expect(parseLocationName('../../etc')).toBeNull();
    expect(parseLocationName('home; drop')).toBeNull();
    expect(parseLocationName('a'.repeat(33))).toBeNull();
    expect(parseLocationName(undefined)).toBeNull();
  });
});

describe('command sets', () => {
  it('classifies every command the parser can convert as deterministic', () => {
    for (const name of [
      'come',
      'goto',
      'follow',
      'guard',
      'stop',
      'eat',
      'equip',
      'drop',
      'mine',
      'deposit',
      'withdraw',
    ]) {
      expect(DETERMINISTIC_COMMANDS.has(name)).toBe(true);
    }
  });

  it('marks the chat-only commands as local, and local ones as deterministic', () => {
    for (const name of ['stop', 'status', 'inventory', 'help', 'remember', 'home']) {
      expect(LOCAL_COMMANDS.has(name)).toBe(true);
      expect(DETERMINISTIC_COMMANDS.has(name)).toBe(true);
    }
  });

  it('does not treat an arbitrary word as deterministic', () => {
    expect(DETERMINISTIC_COMMANDS.has('please')).toBe(false);
    expect(DETERMINISTIC_COMMANDS.has('')).toBe(false);
  });
});