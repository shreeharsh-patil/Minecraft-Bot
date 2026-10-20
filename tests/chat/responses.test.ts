/**
 * Outbound chat: length budget, failure handling and teardown.
 *
 * The responder is the last place a line is shaped before it reaches the
 * server, so these tests pin the properties the server itself enforces:
 * a line is never longer than 256 characters, a failed send never strands
 * the caller, and nothing is emitted after the responder was closed.
 */
import { describe, expect, it } from 'vitest';
import { ChatResponder, formatStatus } from '../../src/chat/responses.js';
import { silentLogger } from '../../src/utils/logger.js';

/** The vanilla server limit: a longer line is rejected and the client is dropped. */
const SERVER_LINE_LIMIT = 256;

/** A responder that records the lines it emits. */
function recorder(minIntervalMs = 0): { responder: ChatResponder; lines: string[] } {
  const lines: string[] = [];
  const responder = new ChatResponder(silentLogger, minIntervalMs);
  responder.emit = (text: string): void => {
    lines.push(text);
  };
  return { responder, lines };
}

describe('ChatResponder - the server line limit', () => {
  it('keeps the whole line (name prefix included) within 256 characters', async () => {
    const { responder, lines } = recorder();
    // A 16-character name is the longest a Minecraft username can be.
    await responder.send('SixteenCharsName', 'x'.repeat(1_000));

    expect(lines).toHaveLength(1);
    expect(lines[0]?.length ?? 0).toBeLessThanOrEqual(SERVER_LINE_LIMIT);
    expect(lines[0]?.startsWith('SixteenCharsName, ')).toBe(true);
  });

  it('spends the prefix out of the body budget', async () => {
    const { responder, lines } = recorder();
    await responder.send('Alice', 'y'.repeat(1_000));

    // The prefix is charged against the limit, so the body is shorter than
    // the budget it would get without a prefix.
    const body = (lines[0] ?? '').slice('Alice, '.length);
    expect(body.length).toBe(SERVER_LINE_LIMIT - 'Alice, '.length);
  });

  it('bounds a bare announcement to the same limit', async () => {
    const { responder, lines } = recorder();
    await responder.announce('z'.repeat(1_000));

    expect(lines[0]?.length ?? 0).toBeLessThanOrEqual(SERVER_LINE_LIMIT);
  });

  it('never exceeds the limit even with a long name prefix', async () => {
    const { responder, lines } = recorder();
    await responder.send('A'.repeat(120), 'w'.repeat(1_000));

    expect(lines[0]?.length ?? 0).toBeLessThanOrEqual(SERVER_LINE_LIMIT);
  });

  it('sends a short reply unchanged', async () => {
    const { responder, lines } = recorder();
    await responder.send('Alice', 'Done!');

    expect(lines).toEqual(['Alice, Done!']);
  });
});

describe('ChatResponder - a failing send never strands the caller', () => {
  it('resolves the sender when the emit throws', async () => {
    const responder = new ChatResponder(silentLogger, 0);
    responder.emit = (): void => {
      throw new Error('socket closed');
    };

    await expect(responder.send('Alice', 'hello')).resolves.toBeUndefined();
  });

  it('does not raise an unhandled rejection when the emit throws', async () => {
    const failures: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      failures.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const responder = new ChatResponder(silentLogger, 0);
      responder.emit = (): void => {
        throw new Error('socket closed');
      };
      await responder.send('Alice', 'hello');
      // Give the microtask queue a chance to report a floating rejection.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(failures).toEqual([]);
  });

  it('keeps sending after one line failed', async () => {
    const lines: string[] = [];
    const responder = new ChatResponder(silentLogger, 0);
    let first = true;
    responder.emit = (text: string): void => {
      if (first) {
        first = false;
        throw new Error('socket closed');
      }
      lines.push(text);
    };

    await responder.send('Alice', 'one');
    await responder.send('Alice', 'two');

    expect(lines).toEqual(['Alice, two']);
  });
});

describe('ChatResponder - clear() cancels the line in flight', () => {
  it('does not emit a line that was being sent when clear() was called', async () => {
    // The first line goes out immediately; the second one has to wait for
    // the rate-limit gap, which is the window clear() has to cancel.
    const { responder, lines } = recorder(50);
    await responder.send('Alice', 'first');
    const pending = responder.send('Alice', 'second');
    responder.clear();

    await expect(pending).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lines).toEqual(['Alice, first']);
  });

  it('releases every waiting sender', async () => {
    const { responder } = recorder(50);
    const first = responder.send('Alice', 'one');
    const second = responder.send('Alice', 'two');
    responder.clear();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('emits nothing at all after the responder was closed', async () => {
    const { responder, lines } = recorder();
    responder.clear();
    await responder.send('Alice', 'after teardown');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(lines).toEqual([]);
  });
});

describe('formatStatus', () => {
  const base = {
    username: 'TestBot',
    health: 20,
    maxHealth: 20,
    food: 20,
    dimension: 'overworld',
    position: { x: 1, y: 64, z: -3 },
    activeTasks: [],
    brain: 'idle',
  };

  it('reports the remaining command budget when it is known', () => {
    const status = formatStatus({ ...base, remainingCommands: 7 });

    expect(status).toContain('7 cmd left');
  });

  it('omits the budget when it is unknown', () => {
    const status = formatStatus(base);

    expect(status).not.toContain('cmd left');
    expect(status).toBe('HP 20/20, food 20, overworld at 1,64,-3. idle. idle');
  });
});
