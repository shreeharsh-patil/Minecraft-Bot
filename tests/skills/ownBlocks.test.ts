/**
 * The bot must not dig up its own constructions.
 *
 * "build a wall" followed by "mine 20 cobblestone" used to demolish the wall
 * the player had just asked for: nothing tracked which blocks the bot placed.
 */
import { describe, expect, it } from 'vitest';
import { FakeMinecraftFacade } from '../skills/fakes/fakeFacade.js';
import { runMining } from '../../src/skills/mining/shared.js';
import { AntiGriefRules } from '../../src/safety/antiGrief.js';
import { silentLogger } from '../../src/utils/logger.js';
import type { ExecutionContext } from '../../src/types/task.js';

function context(): ExecutionContext {
  return {
    signal: new AbortController().signal,
    say: () => undefined,
    progress: () => undefined,
    logger: silentLogger,
    owner: 'Alice',
  } as unknown as ExecutionContext;
}

describe('mining never breaks the bot\'s own blocks', () => {
  it('skips a block the bot placed itself', async () => {
    const facade = new FakeMinecraftFacade();
    facade.addItem('cobblestone', 10);
    // The bot built a cobblestone block here...
    await facade.placeBlock({ x: 2, y: 64, z: 2 }, 'cobblestone');
    expect(facade.isOwnBlock({ x: 2, y: 64, z: 2 })).toBe(true);

    // ...and there is natural cobblestone elsewhere.
    facade.addBlock('cobblestone', { x: 8, y: 64, z: 0 });

    const result = await runMining(
      facade,
      context(),
      {
        names: ['cobblestone'],
        label: 'cobblestone',
        count: 1,
        searchDistance: 16,
        rules: new AntiGriefRules(),
      },
    );

    // The natural block was mined, the bot's own block was left alone.
    expect(facade.dugPositions.map((p) => `${p.x},${p.y},${p.z}`)).not.toContain('2,64,2');
    expect(result.mined).toBe(1);
  });
});
