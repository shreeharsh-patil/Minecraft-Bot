/**
 * Audit of the mineflayer facade (src/bot/mineflayerFacade.ts).
 *
 * The facade is the only place in the bot that talks to the game library, so
 * a wrong argument type or a missing guard here silently kills a whole
 * feature (equipping, placing, looking, chest lookups). These tests pin the
 * contract against the INSTALLED libraries:
 *   - mineflayer 4.39.0 (lib/plugins/simple_inventory.js, lib/plugins/
 *     blocks.js, lib/plugins/place_block.js)
 *   - prismarine-windows 2.10.0 (lib/Window.js)
 *
 * Every test below fails without the matching fix in the facade.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { MineflayerFacade } from '../../src/bot/mineflayerFacade.js';
import type { Logger } from '../../src/utils/logger.js';

const require = createRequire(import.meta.url);

/** The real mineflayer equip plugin - the source of the equip() contract. */
const injectSimpleInventory = require('mineflayer/lib/plugins/simple_inventory.js') as (
  bot: unknown,
) => void;
/** The real 1.21.1 item registry (ids, names and metadata). */
const registry = require('prismarine-registry')('1.21.1');
/** The real prismarine-item factory, bound to the registry above. */
const Item = require('prismarine-item')(registry) as new (
  type: number,
  count: number,
  metadata: number,
) => any;
/** The real prismarine-windows factory. */
const windows = require('prismarine-windows')('1.21.1') as {
  createWindow: (id: number, type: string, title: string) => any;
};

/** mineflayer's equip() signature, as the facade has to use it. */
type EquipFn = (item: unknown, destination: unknown) => Promise<void>;

interface LogRecord {
  level: string;
  msg: string;
  fields?: Record<string, unknown>;
}

/** A logger that keeps every record so a test can assert on it. */
function recordingLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const make = (): Logger => ({
    level: 'debug',
    debug: (msg: string, fields?: Record<string, unknown>) => {
      records.push({ level: 'debug', msg, fields });
    },
    info: (msg: string, fields?: Record<string, unknown>) => {
      records.push({ level: 'info', msg, fields });
    },
    warn: (msg: string, fields?: Record<string, unknown>) => {
      records.push({ level: 'warn', msg, fields });
    },
    error: (msg: string, fields?: Record<string, unknown>) => {
      records.push({ level: 'error', msg, fields });
    },
    child: () => make(),
  });
  return { logger: make(), records };
}

/**
 * A bot wired with the REAL mineflayer equip() implementation and a real
 * prismarine-windows inventory, so the equip contract is the production one
 * and not a mock of it.
 */
function realEquipBot(): { bot: any; equipArgs: unknown[] } {
  const bot: any = {
    supportFeature: () => false,
    inventory: windows.createWindow(0, 'minecraft:inventory', 'Inventory'),
    quickBarSlot: 0,
    _client: { write: () => undefined },
    clickWindow: () => Promise.resolve(),
    updateHeldItem: () => undefined,
    moveSlotItem: () => Promise.resolve(),
    registry,
  };
  injectSimpleInventory(bot);

  const equipArgs: unknown[] = [];
  const realEquip = bot.equip.bind(bot) as EquipFn;
  bot.equip = (item: unknown, destination: unknown): Promise<void> => {
    equipArgs.push(item);
    return realEquip(item, destination);
  };

  // One stack of stone and one of bread in the player's inventory.
  bot.inventory.updateSlot(10, new Item(registry.itemsByName['stone'].id, 5, 0));
  bot.inventory.updateSlot(11, new Item(registry.itemsByName['bread'].id, 3, 0));
  return { bot, equipArgs };
}

describe('facade: equipping', () => {
  it('equips by NUMERIC item id, not by name (mineflayer rejects names)', async () => {
    const { bot, equipArgs } = realEquipBot();
    const { logger } = recordingLogger();
    const facade = new MineflayerFacade(bot, logger);

    // mineflayer's equip() throws "Invalid item object in equip" for a name.
    await expect(facade.equipItem('stone')).resolves.toBe(true);
    expect(typeof equipArgs[0]).toBe('number');
    expect(equipArgs[0]).toBe(registry.itemsByName['stone'].id);
  });

  it('reports a failure (no throw) when the item is not carried', async () => {
    const { bot } = realEquipBot();
    const { logger } = recordingLogger();
    const facade = new MineflayerFacade(bot, logger);

    await expect(facade.equipItem('diamond_sword')).resolves.toBe(false);
  });

  it('rejects an unknown item name without touching the library', async () => {
    const { bot, equipArgs } = realEquipBot();
    const { logger } = recordingLogger();
    const facade = new MineflayerFacade(bot, logger);

    await expect(facade.equipItem('not_a_real_item')).resolves.toBe(false);
    expect(equipArgs).toHaveLength(0);
  });

  it('eat() equips the food by numeric id too', async () => {
    const { bot, equipArgs } = realEquipBot();
    const { logger } = recordingLogger();
    let consumed = false;
    bot.consume = (): Promise<void> => {
      consumed = true;
      return Promise.resolve();
    };
    const facade = new MineflayerFacade(bot, logger);

    await expect(facade.eat('bread')).resolves.toBe(true);
    expect(equipArgs[0]).toBe(registry.itemsByName['bread'].id);
    expect(consumed).toBe(true);
  });
});

describe('facade: lookAt', () => {
  it('handles an async mineflayer failure instead of leaking a rejection', async () => {
    const { logger, records } = recordingLogger();
    // `bot.lookAt` is async in mineflayer: a failure arrives as a rejection.
    const bot: any = { lookAt: () => Promise.reject(new Error('bot is not spawned')) };
    const facade = new MineflayerFacade(bot, logger);

    facade.lookAt({ x: 0, y: 64, z: 0 });
    // Give the rejection a chance to surface.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(records.some((record) => record.msg === 'lookAt failed')).toBe(true);
  });
});

describe('facade: world queries before spawn', () => {
  it('findNearestChest returns null instead of throwing when the bot is not spawned', () => {
    const { logger } = recordingLogger();
    const bot: any = {
      entity: undefined,
      // mineflayer: `const point = (options.point || bot.entity.position).floored()`
      // throws when there is no entity yet.
      findBlock: (options: any) => {
        const point = (options.point || bot.entity.position).floored();
        return point ? null : null;
      },
    };
    const facade = new MineflayerFacade(bot, logger);

    expect(() => facade.findNearestChest(16)).not.toThrow();
    expect(facade.findNearestChest(16)).toBeNull();
    // The sibling lookup has always been guarded.
    expect(facade.findNearestBlock('stone', 16)).toBeNull();
  });
});

describe('facade: placing blocks', () => {
  it('tries the next reference when the server refuses the first one', async () => {
    const { logger } = recordingLogger();
    const attempts: Array<{ reference: { x: number; y: number; z: number }; face: any }> = [];
    const bot: any = {
      registry,
      blockAt: (point: any) => ({ name: 'stone', position: { x: point.x, y: point.y, z: point.z } }),
      placeBlock: (reference: any, face: any): Promise<void> => {
        attempts.push({ reference: reference.position, face });
        if (attempts.length === 1) {
          return Promise.reject(new Error('Server refused to place cobblestone'));
        }
        return Promise.resolve();
      },
    };
    const facade = new MineflayerFacade(bot, logger);

    await expect(
      facade.placeBlock({ x: 10, y: 64, z: 10 }, 'cobblestone', 'auto'),
    ).resolves.toBe(true);

    expect(attempts.length).toBe(2);
    // Every candidate must land on the requested cell - never one cell off.
    for (const attempt of attempts) {
      expect(attempt.reference.x + attempt.face.x).toBe(10);
      expect(attempt.reference.y + attempt.face.y).toBe(64);
      expect(attempt.reference.z + attempt.face.z).toBe(10);
    }
    expect(facade.isOwnBlock({ x: 10, y: 64, z: 10 })).toBe(true);
  });

  it('fails cleanly when every reference is refused', async () => {
    const { logger } = recordingLogger();
    const bot: any = {
      registry,
      blockAt: (point: any) => ({ name: 'stone', position: { x: point.x, y: point.y, z: point.z } }),
      placeBlock: (): Promise<void> => Promise.reject(new Error('Server did not answer the placement')),
    };
    const facade = new MineflayerFacade(bot, logger);

    await expect(
      facade.placeBlock({ x: 10, y: 64, z: 10 }, 'cobblestone', 'auto'),
    ).resolves.toBe(false);
    expect(facade.isOwnBlock({ x: 10, y: 64, z: 10 })).toBe(false);
  });
});

describe('facade: chest transfers', () => {
  function chestBot(windowOverrides: Record<string, unknown> = {}): {
    bot: any;
    transfers: any[];
    closed: () => boolean;
  } {
    const transfers: any[] = [];
    let closed = false;
    const window: any = {
      inventoryStart: 27,
      inventoryEnd: 63,
      items: () => [],
      containerItems: () => [{ name: 'cobblestone', count: 5 }],
      close: () => {
        closed = true;
      },
      ...windowOverrides,
    };
    const bot: any = {
      registry,
      inventory: { count: () => 5, items: () => [] },
      blockAt: () => ({ name: 'chest', position: { x: 1, y: 2, z: 3 } }),
      currentWindow: null,
      openContainer: (): Promise<void> => {
        bot.currentWindow = window;
        return Promise.resolve();
      },
      transfer: (options: any): Promise<void> => {
        transfers.push(options);
        return Promise.resolve();
      },
    };
    return { bot, transfers, closed: () => closed };
  }

  it('deposits from the player inventory region of the chest window', async () => {
    const { bot, transfers, closed } = chestBot();
    const { logger } = recordingLogger();
    const facade = new MineflayerFacade(bot, logger);

    await expect(
      facade.depositIntoChest({ x: 1, y: 2, z: 3 }, 'cobblestone', 3),
    ).resolves.toBe(3);

    const options = transfers[0];
    expect(options.sourceStart).toBe(27);
    expect(options.sourceEnd).toBe(63);
    expect(options.destStart).toBe(0);
    expect(options.destEnd).toBe(27);
    expect(closed()).toBe(true);
  });

  it('withdraws from the chest region into the player inventory region', async () => {
    const { bot, transfers } = chestBot();
    const { logger } = recordingLogger();
    const facade = new MineflayerFacade(bot, logger);

    await expect(
      facade.withdrawFromChest({ x: 1, y: 2, z: 3 }, 'cobblestone', 3),
    ).resolves.toBe(3);

    const options = transfers[0];
    expect(options.sourceStart).toBe(0);
    expect(options.sourceEnd).toBe(27);
    expect(options.destStart).toBe(27);
    expect(options.destEnd).toBe(63);
  });

  it('falls back to the container layout (27..63), not the backpack slots', async () => {
    const { bot, transfers } = chestBot({ inventoryStart: undefined, inventoryEnd: undefined });
    const { logger } = recordingLogger();
    const facade = new MineflayerFacade(bot, logger);

    await facade.depositIntoChest({ x: 1, y: 2, z: 3 }, 'cobblestone', 3);

    const options = transfers[0];
    expect(options.sourceStart).toBe(27);
    expect(options.sourceEnd).toBe(63);
  });

  it('closes the window it opened even when currentWindow was reset', async () => {
    const { logger } = recordingLogger();
    let closed = false;
    const window: any = {
      inventoryStart: 27,
      inventoryEnd: 63,
      items: () => [],
      containerItems: () => [{ name: 'cobblestone', count: 5 }],
      close: () => {
        closed = true;
      },
    };
    const bot: any = {
      registry,
      inventory: { count: () => 5, items: () => [] },
      blockAt: () => ({ name: 'chest', position: { x: 1, y: 2, z: 3 } }),
      // The server already reset the current window (a close_window packet
      // raced in) - the opened window still has to be closed.
      currentWindow: null,
      openContainer: () => Promise.resolve(window),
      transfer: () => Promise.resolve(),
    };
    const facade = new MineflayerFacade(bot, logger);

    await facade.depositIntoChest({ x: 1, y: 2, z: 3 }, 'cobblestone', 3);

    expect(closed).toBe(true);
  });
});

describe('facade: counting items', () => {
  it('resolves the name to a numeric id before counting', () => {
    const { logger } = recordingLogger();
    const stoneId = registry.itemsByName['stone'].id;
    const counted: number[] = [];
    const bot: any = {
      registry,
      inventory: {
        count: (id: number) => {
          counted.push(id);
          return id === stoneId ? 7 : 0;
        },
      },
    };
    const facade = new MineflayerFacade(bot, logger);

    expect(facade.countItem('stone')).toBe(7);
    expect(counted[0]).toBe(stoneId);
  });
});
