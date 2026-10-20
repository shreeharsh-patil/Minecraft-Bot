/**
 * Planner parameter validation.
 *
 * The planner's rule is "dropping is always safer than coercing": a value the
 * model got wrong must make the action invalid, never turn into a
 * different - possibly destructive - action. `{"count": "all"}` must not
 * become "drop exactly one diamond", and an empty coordinate must not
 * become the world origin.
 */
import { describe, expect, it } from 'vitest';
import { parseActions } from '../../src/ai/planner.js';

describe('planner - counts are never coerced', () => {
  it('drops an action whose count cannot be read instead of coercing it to 1', () => {
    const { actions, dropped } = parseActions({
      actions: [{ type: 'drop_item', item: 'diamond', count: 'all' }],
    });
    expect(actions).toEqual([]);
    expect(dropped.map((entry) => entry.reason)).toEqual(['invalid-parameters:drop_item']);
  });

  it('does not turn an empty count into zero', () => {
    const { actions, dropped } = parseActions({
      actions: [{ type: 'drop_item', item: 'diamond', count: '' }],
    });
    expect(actions).toEqual([]);
    expect(dropped).toHaveLength(1);
  });

  it('omits an absent optional count instead of inventing one', () => {
    const { actions, dropped } = parseActions({ actions: [{ type: 'drop_item', item: 'diamond' }] });
    expect(actions).toEqual([{ type: 'drop_item', item: 'diamond' }]);
    expect(dropped).toEqual([]);
  });

  it('keeps a count that is a plain number', () => {
    const { actions, dropped } = parseActions({
      actions: [{ type: 'drop_item', item: 'diamond', count: 3 }],
    });
    expect(actions).toEqual([{ type: 'drop_item', item: 'diamond', count: 3 }]);
    expect(dropped).toEqual([]);
  });

  it('drops a malformed count on every action that takes one', () => {
    const candidates = [
      { type: 'mine_block', blockName: 'oak_log', count: 'all' },
      { type: 'collect_resource', resource: 'oak_log', count: 'all' },
      { type: 'withdraw_items', item: 'diamond', count: 'all' },
      { type: 'pickup_items', item: 'diamond', count: 'all' },
      { type: 'drop_item', item: 'diamond', count: 'all' },
      { type: 'drop_item', item: 'diamond', count: '' },
    ];
    for (const candidate of candidates) {
      const { actions, dropped } = parseActions({ actions: [candidate] });
      expect(actions, JSON.stringify(candidate)).toEqual([]);
      expect(dropped, JSON.stringify(candidate)).toHaveLength(1);
    }
  });

  it('still requires a count where the count is mandatory', () => {
    const { actions } = parseActions({ actions: [{ type: 'mine_block', blockName: 'oak_log' }] });
    expect(actions).toEqual([]);
  });
});

describe('planner - numbers are never coerced', () => {
  it('drops a position with an empty coordinate instead of walking to 0,0,0', () => {
    const { actions, dropped } = parseActions({
      actions: [{ type: 'move_to_position', position: { x: '', y: 64, z: 10 } }],
    });
    expect(actions).toEqual([]);
    expect(dropped.map((entry) => entry.reason)).toEqual(['invalid-parameters:move_to_position']);
  });

  it('drops a position with a whitespace-only coordinate', () => {
    const { actions } = parseActions({
      actions: [{ type: 'move_to_position', position: { x: '   ', y: 64, z: 10 } }],
    });
    expect(actions).toEqual([]);
  });

  it('drops a duration that is only whitespace', () => {
    const { actions } = parseActions({ actions: [{ type: 'wait', durationMs: ' ' }] });
    expect(actions).toEqual([]);
  });

  it('drops a duration that is not a number at all', () => {
    const { actions } = parseActions({ actions: [{ type: 'wait', durationMs: 'soon' }] });
    expect(actions).toEqual([]);
  });

  it('still accepts an ordinary coordinate', () => {
    const { actions } = parseActions({
      actions: [{ type: 'move_to_position', position: { x: 1, y: 64, z: -2 } }],
    });
    expect(actions).toEqual([{ type: 'move_to_position', position: { x: 1, y: 64, z: -2 } }]);
  });
});

describe('planner - validation happens before the action cap', () => {
  it('reports the real failure of an invalid action beyond the cap', () => {
    const { actions, dropped } = parseActions(
      {
        actions: [
          { type: 'stop' },
          { type: 'mine_block', blockName: 'oak_log', count: 3 },
          { type: 'drop_item', item: 'diamond', count: 'all' },
        ],
      },
      2,
    );
    expect(actions).toHaveLength(2);
    expect(dropped.map((entry) => entry.reason)).toEqual(['invalid-parameters:drop_item']);
  });

  it('still caps the number of valid actions', () => {
    const many = Array.from({ length: 10 }, () => ({ type: 'stop' }));
    const { actions, dropped } = parseActions({ actions: many }, 3);
    expect(actions).toHaveLength(3);
    expect(dropped.filter((entry) => entry.reason === 'max-actions-exceeded')).toHaveLength(7);
  });
});
