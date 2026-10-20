/**
 * Audit regressions for the AI context builder and the memory store.
 *
 * Every test in this file fails without the fix it covers:
 *  - a limit of 0 (or a negative limit) must never make the payload
 *    BIGGER than the limit asked for;
 *  - a broken memory source must not throw out of the builder;
 *  - a player-supplied name must not reach Object.prototype;
 *  - the durable maps must stay bounded.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCompactContext, DEFAULT_CONTEXT_LIMITS } from '../../src/ai/contextBuilder.js';
import type { ContextMemorySource, WorldContextSource } from '../../src/ai/contextBuilder.js';
import { createMemoryStore } from '../../src/ai/memory.js';

function makeWorld(overrides: Partial<WorldContextSource> = {}): WorldContextSource {
  return {
    getPosition: () => ({ x: 0, y: 64, z: 0 }),
    getDimension: () => 'minecraft:overworld',
    getTimeOfDay: () => 'day',
    getHealth: () => ({ current: 20, max: 20 }),
    getHunger: () => ({ current: 20, saturation: 5 }),
    getNearbyPlayers: () => [],
    getNearbyEntities: () => [],
    scanNearbyBlocks: () => [],
    getInventory: () => [],
    heldItem: () => null,
    ...overrides,
  };
}

function chat(count: number): ContextMemorySource['conversation'] {
  return Array.from({ length: count }, (_, index) => ({
    player: 'Steve',
    text: `message ${index}`,
    at: index,
  }));
}

describe('context builder - the limits are limits', () => {
  it('treats a chat limit of 0 as "no chat at all"', () => {
    const context = buildCompactContext(makeWorld(), { conversation: chat(12) }, {
      limits: { maxConversationTurns: 0 },
    });

    // `slice(-0)` is `slice(0)`, which returns the WHOLE window: the limit
    // was silently ignored and the payload was as big as the memory allowed.
    expect(context.recentChat).toEqual([]);
  });

  it('never keeps more than the limit when the limit is negative', () => {
    const world = makeWorld({
      getNearbyPlayers: () => [
        { name: 'A', distance: 1, position: { x: 1, y: 64, z: 0 }, authorized: true },
        { name: 'B', distance: 2, position: { x: 2, y: 64, z: 0 }, authorized: false },
        { name: 'C', distance: 3, position: { x: 3, y: 64, z: 0 }, authorized: false },
      ],
    });

    const context = buildCompactContext(world, { conversation: chat(12) }, {
      limits: { maxPlayers: -1, maxConversationTurns: -3 },
    });

    // `slice(0, -1)` keeps everything but the LAST item and `slice(3)`
    // keeps everything from the third item on - both are bigger than the
    // limit that was asked for.
    expect(context.nearbyPlayers).toEqual([]);
    expect(context.recentChat).toEqual([]);
  });

  it('keeps the default limits when the caller passes nonsense', () => {
    const context = buildCompactContext(makeWorld(), { conversation: chat(12) }, {
      limits: { maxConversationTurns: Number.NaN, maxPlayers: Number.POSITIVE_INFINITY },
    });

    expect(context.recentChat.length).toBe(DEFAULT_CONTEXT_LIMITS.maxConversationTurns);
  });
});

describe('context builder - a broken memory source cannot break the request', () => {
  it('degrades to no chat when the conversation is not a list', () => {
    const broken = {
      conversation: 'not a list' as unknown as ContextMemorySource['conversation'],
    };

    const context = buildCompactContext(makeWorld(), broken);

    expect(context.recentChat).toEqual([]);
  });

  it('degrades to no chat when a turn is malformed', () => {
    const broken = {
      conversation: [
        { player: 'Steve', text: undefined as unknown as string, at: 0 },
      ],
    };

    const context = buildCompactContext(makeWorld(), broken);

    expect(context.recentChat).toEqual([]);
  });
});

describe('memory store - player supplied names never reach Object.prototype', () => {
  it('stores "constructor" under its own name', () => {
    const store = createMemoryStore();

    store.rememberLocation('constructor', { x: 1, y: 64, z: 2 });

    // The lookup used to read Object.prototype.constructor and stored the
    // location under the display name "Object".
    expect(store.recallLocation('constructor')?.name).toBe('constructor');
    expect(store.listLocations().map((location) => location.name)).toEqual(['constructor']);
  });

  it('keeps "__proto__" in the saved file instead of losing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcbot-audit-'));
    const file = join(dir, 'memory.json');
    const store = createMemoryStore({ file });

    try {
      store.rememberLocation('__proto__', { x: 1, y: 64, z: 2 });
      await store.persist();

      // The entry used to vanish: it replaced the prototype of the map
      // instead of being a key in it, so it was never listed or saved.
      expect(store.listLocations().map((location) => location.name)).toEqual(['__proto__']);
      const raw = JSON.parse(await readFile(file, 'utf8')) as {
        persistent: { namedLocations: Record<string, unknown> };
      };
      expect(Object.keys(raw.persistent.namedLocations)).toEqual(['__proto__']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads a "__proto__" entry back from a saved file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcbot-audit-'));
    const file = join(dir, 'memory.json');
    const store = createMemoryStore({ file });

    try {
      store.rememberLocation('__proto__', { x: 1, y: 64, z: 2 });
      await store.persist();

      const reloaded = createMemoryStore({ file });
      await reloaded.load();

      expect(reloaded.recallLocation('__proto__')?.position).toEqual({ x: 1, y: 64, z: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('memory store - the durable maps stay bounded', () => {
  it('does not let "!remember" spam grow the location map without limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcbot-audit-'));
    const file = join(dir, 'memory.json');
    const store = createMemoryStore({ file });

    try {
      for (let index = 0; index < 500; index += 1) {
        store.rememberLocation(`place${index}`, { x: index, y: 64, z: 0 });
      }

      // The map is chat-reachable, so it needs a ceiling.
      expect(store.listLocations().length).toBeLessThanOrEqual(128);

      await store.persist();
      const raw = JSON.parse(await readFile(file, 'utf8')) as {
        persistent: { namedLocations: Record<string, unknown> };
      };
      expect(Object.keys(raw.persistent.namedLocations).length).toBeLessThanOrEqual(128);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the location that was just remembered', () => {
    const store = createMemoryStore();

    for (let index = 0; index < 500; index += 1) {
      store.rememberLocation(`place${index}`, { x: index, y: 64, z: 0 });
    }

    expect(store.recallLocation('place499')).toBeDefined();
  });
});
