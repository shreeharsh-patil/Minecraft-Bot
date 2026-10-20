/**
 * Audit of the world tracker (`src/world/worldState.ts`).
 *
 * The tracker is the cached snapshot of nearby blocks, hostiles, chests and
 * players that the planner sees. Three properties matter:
 *
 *  1. a failing world query must never take the whole snapshot down;
 *  2. the snapshot must keep the information a decision needs - notably the
 *     entity id, without which a hostile cannot be attacked;
 *  3. the scan cache must expire. A cache that survives its TTL (or that
 *     never starts) means the bot plans against a world that is not there.
 */
import { describe, expect, it } from 'vitest';
import { WorldState } from '../../src/world/worldState.js';
import { createLogger } from '../../src/utils/logger.js';
import type { BlockRef, ChestRef } from '../../src/types/facade.js';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';

const LOG = { x: 1, y: 64, z: 0 };

/** A facade that counts the expensive queries and can be made to fail. */
class SpyFacade extends FakeMinecraftFacade {
  public scanCalls = 0;
  public chestCalls = 0;
  public chestError: Error | null = null;

  public override scanNearbyBlocks(radius: number): BlockRef[] {
    this.scanCalls += 1;
    return super.scanNearbyBlocks(radius);
  }

  public override findNearestChest(maxDistance: number): ChestRef | null {
    this.chestCalls += 1;
    if (this.chestError) throw this.chestError;
    return super.findNearestChest(maxDistance);
  }
}

function capture(): { logger: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    format: 'json',
    sink: (line) => lines.push(line),
    errorSink: (line) => lines.push(line),
  });
  return { logger, lines };
}

function worldWithLog(): SpyFacade {
  return new SpyFacade({
    position: { x: 0, y: 64, z: 0 },
    blocks: [{ name: 'oak_log', at: LOG }],
    chests: [{ at: { x: 3, y: 64, z: 0 } }],
  });
}

describe('world state - a failed world query must not break the snapshot', () => {
  it('degrades to "no chest" when the chest lookup throws', () => {
    const facade = worldWithLog();
    // The real chest lookup walks the world and throws when the bot is not
    // spawned yet; the snapshot must survive that.
    facade.chestError = new Error('bot.entity is not set');
    const { logger, lines } = capture();
    const state = new WorldState(facade, logger);

    const context = state.buildContext(1_000);

    expect(context.nearbyChests).toEqual([]);
    // The rest of the snapshot is still built.
    expect(context.nearbyBlocks.map((b) => b.name)).toEqual(['oak_log']);
    expect(lines.some((line) => line.includes('nearest chest lookup failed'))).toBe(true);
  });

  it('keeps the chest lookup cached after a failure so it is not retried every request', () => {
    const facade = worldWithLog();
    facade.chestError = new Error('bot.entity is not set');
    const { logger } = capture();
    const state = new WorldState(facade, logger);

    state.buildContext(1_000);
    state.buildContext(1_100);

    expect(facade.chestCalls).toBe(1);
  });
});

describe('world state - the snapshot keeps what a decision needs', () => {
  it('carries the entity id of a hostile so it can actually be attacked', () => {
    const facade = new SpyFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [
        {
          name: 'zombie',
          type: 'hostile',
          distance: 0,
          position: { x: 2, y: 64, z: 0 },
          health: 20,
          id: 4242,
        },
      ],
    });
    const { logger } = capture();
    const state = new WorldState(facade, logger);

    const context = state.buildContext(1_000);

    expect(context.nearbyHostiles).toHaveLength(1);
    // Without the id the bot can only swing at the air: the damage is
    // delivered by an entity attack packet.
    expect(context.nearbyHostiles[0]?.id).toBe(4242);
    expect(context.nearbyHostiles[0]?.health).toBe(20);
  });

  it('omits the id when the facade does not know one', () => {
    const facade = new SpyFacade({
      position: { x: 0, y: 64, z: 0 },
      entities: [
        {
          name: 'creeper',
          type: 'hostile',
          distance: 0,
          position: { x: 2, y: 64, z: 0 },
        },
      ],
    });
    const { logger } = capture();
    const state = new WorldState(facade, logger);

    const context = state.buildContext(1_000);

    expect(context.nearbyHostiles).toHaveLength(1);
    expect('id' in (context.nearbyHostiles[0] ?? {})).toBe(false);
  });
});

describe('world state - the scan cache expires', () => {
  it('re-scans when the clock moves backwards instead of freezing the snapshot', () => {
    const facade = worldWithLog();
    const { logger } = capture();
    const state = new WorldState(facade, logger);

    state.buildContext(10_000);
    expect(facade.scanCalls).toBe(1);

    // The clock stepped backwards (an NTP correction, or a caller passing an
    // earlier `now`): the age of the cache is now negative, which must not
    // count as "still fresh".
    state.buildContext(9_000);

    expect(facade.scanCalls).toBe(2);
  });

  it('scans on the very first build even when the injected clock starts at zero', () => {
    const facade = worldWithLog();
    const { logger } = capture();
    const state = new WorldState(facade, logger);

    const context = state.buildContext(0);

    expect(facade.scanCalls).toBe(1);
    expect(facade.chestCalls).toBe(1);
    expect(context.nearbyBlocks.map((b) => b.name)).toEqual(['oak_log']);
    expect(context.nearbyChests).toHaveLength(1);
  });

  it('re-scans after invalidate() even when the clock has not moved', () => {
    const facade = worldWithLog();
    const { logger } = capture();
    const state = new WorldState(facade, logger);

    state.buildContext(1_000);
    state.invalidate();
    state.buildContext(1_000);

    expect(facade.scanCalls).toBe(2);
    expect(facade.chestCalls).toBe(2);
  });

  it('serves the cached scans inside the TTL', () => {
    const facade = worldWithLog();
    const { logger } = capture();
    const state = new WorldState(facade, logger);

    state.buildContext(1_000);
    state.buildContext(1_500);

    expect(facade.scanCalls).toBe(1);
    expect(facade.chestCalls).toBe(1);
  });

  it('re-scans once the TTL has passed', () => {
    const facade = worldWithLog();
    const { logger } = capture();
    const state = new WorldState(facade, logger);

    state.buildContext(1_000);
    state.buildContext(1_000 + 1_000);

    expect(facade.scanCalls).toBe(2);
    expect(facade.chestCalls).toBe(2);
  });
});
