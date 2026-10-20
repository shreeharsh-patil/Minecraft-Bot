/**
 * Durable memory writes.
 *
 * Two quick saves used to share one temp file: the second rename failed and
 * the store could end up torn. A torn file is then treated as corrupt, which
 * loses ALL persistent memory (trusted players, named locations, ...).
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../../src/ai/memory.js';

describe('memory store - durable writes', () => {
  it('serialises concurrent saves so the file is never torn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcbot-memory-'));
    const file = join(dir, 'memory.json');
    const store = createMemoryStore({ file });

    const saves: Array<Promise<void>> = [];
    for (let i = 0; i < 8; i += 1) {
      store.addTrusted(`Player${i}`);
      saves.push(store.persist());
    }

    // Every save must succeed: no rename may lose the race.
    await expect(Promise.all(saves)).resolves.toHaveLength(8);

    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as { persistent: { trustedPlayers: string[] } };
    // The last write wins, and the file holds every trusted player.
    expect(parsed.persistent.trustedPlayers).toHaveLength(8);

    // No staging file is left behind.
    expect(await readdir(dir)).toEqual(['memory.json']);
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the persistent memory loadable after concurrent saves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcbot-memory-'));
    const file = join(dir, 'memory.json');
    const store = createMemoryStore({ file });

    store.addTrusted('Alice');
    store.setPreference('Dirtiness', 'low');
    await Promise.all([store.persist(), store.persist(), store.persist()]);

    const reloaded = createMemoryStore({ file });
    await reloaded.load();
    expect(reloaded.isTrusted('alice')).toBe(true);
    expect(reloaded.getPreference('dirtiness')).toBe('low');

    await rm(dir, { recursive: true, force: true });
  });

  it('gives every write its own staging file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcbot-memory-'));
    const file = join(dir, 'memory.json');
    const store = createMemoryStore({ file });

    await Promise.all([store.persist(), store.persist()]);

    // Only the target file survives: no "<file>.tmp" and no leftovers.
    const entries = await readdir(dir);
    expect(entries).toEqual(['memory.json']);
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });
});
