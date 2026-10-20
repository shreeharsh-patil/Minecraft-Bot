/**
 * Audit of the outbound chat layer (`src/chat/responses.ts`).
 *
 * Three defects are pinned here, each of them a promise the file makes about
 * the lines that reach Minecraft:
 *
 *  1. `formatHelp` promises "each within `maxLength`" but packed the lines
 *     without the trailing '.' it appends, and never checked the first
 *     command - so a help line could be longer than the budget it was given.
 *  2. The file header promises that "every string that can reach Minecraft
 *     chat" is redacted here. The message body was, the name prefix was not:
 *     a control character in the name reached the chat line verbatim and
 *     split it in two.
 *  3. "A failed send must never strand the sender" - but the failure was
 *     reported through the logger, and a logger that throws took the whole
 *     drain down with it: the senders still queued were left on a promise
 *     that never settled, and the rejection was left floating.
 */
import { describe, expect, it } from 'vitest';
import { ChatResponder, formatHelp } from '../../src/chat/responses.js';
import { COMMAND_SYNTAX } from '../../src/chat/commandParser.js';
import { createLogger, silentLogger } from '../../src/utils/logger.js';

/** A responder that records the lines it emits. */
function recorder(minIntervalMs = 0): { responder: ChatResponder; lines: string[] } {
  const lines: string[] = [];
  const responder = new ChatResponder(silentLogger, minIntervalMs);
  responder.emit = (text: string): void => {
    lines.push(text);
  };
  return { responder, lines };
}

describe('formatHelp - every line stays within the budget it was given', () => {
  it('never returns a line longer than maxLength', () => {
    // The budget the caller asks for is the budget the player gets: a line
    // that is one character too long is already a contract broken.
    for (const max of [12, 20, 40, 80, 120, 190, 256]) {
      for (const line of formatHelp('!', max)) {
        expect(line.length).toBeLessThanOrEqual(max);
      }
    }
  });

  it('never returns a line longer than maxLength for a long command prefix', () => {
    // BOT_PREFIX is configurable, so the entries (and with them the packing)
    // move around - the limit still holds.
    for (const max of [40, 80, 190]) {
      for (const line of formatHelp('!'.repeat(40), max)) {
        expect(line.length).toBeLessThanOrEqual(max);
      }
    }
  });

  it('still lists every command, whatever the budget is', () => {
    // A command that does not fit is shortened, never dropped: the help is
    // derived from COMMAND_SYNTAX precisely so that it cannot go stale.
    const text = formatHelp('!', 40).join(' ');
    for (const command of COMMAND_SYNTAX) {
      expect(text).toContain(command.name);
    }
  });

  it('keeps the usual output unchanged for the default budget', () => {
    const lines = formatHelp('!');

    expect(lines[0]?.startsWith('Commands: !come')).toBe(true);
    expect(lines[lines.length - 1]?.endsWith('!help.')).toBe(true);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(190);
    }
  });
});

describe('ChatResponder - the name prefix is sanitised like the message', () => {
  it('never lets a newline in the name reach the chat line', async () => {
    const { responder, lines } = recorder();
    await responder.send('Ali\nce', 'hello');

    // A newline in the line is a second chat line on the server, and the
    // length budget was charged for one line.
    expect(lines).toHaveLength(1);
    expect(lines[0] ?? '').not.toContain('\n');
  });

  it('never lets a control character in the name reach the chat line', async () => {
    const { responder, lines } = recorder();
    await responder.send('Ali\u0007ce', 'hello');

    expect(lines[0] ?? '').not.toContain('\u0007');
    expect(lines[0] ?? '').toBe('Ali ce, hello');
  });

  it('keeps the whole line within the server limit with a hostile name', async () => {
    const { responder, lines } = recorder();
    await responder.send(`${'A'.repeat(200)}\nInjected`, 'x'.repeat(1_000));

    const line = lines[0] ?? '';
    expect(line.length).toBeLessThanOrEqual(256);
    expect(line).not.toContain('\n');
  });

  it('still addresses a normal player by name', async () => {
    const { responder, lines } = recorder();
    await responder.send('Alice', 'Done!');

    expect(lines).toEqual(['Alice, Done!']);
  });
});

describe('ChatResponder - a failing send never strands the sender', () => {
  it('releases the queued senders when the failure report itself fails', async () => {
    // The log sink is the last thing that can go wrong, and it must not take
    // the queue down with it.
    const logger = createLogger({
      level: 'error',
      sink: () => undefined,
      errorSink: () => {
        throw new Error('log sink down');
      },
    });
    // A gap between the lines, so the second one is still queued while the
    // first one fails.
    const responder = new ChatResponder(logger, 20);
    let broken = false;
    responder.emit = (): void => {
      if (broken) throw new Error('socket closed');
    };
    // The warm-up line goes out immediately and arms the rate limit, so the
    // next line waits: that is the window in which the second one is still
    // queued when the first one fails.
    await responder.send('Alice', 'warmup');
    broken = true;

    const failures: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      failures.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const first = responder.send('Alice', 'one');
      const second = responder.send('Alice', 'two');
      const settled = await Promise.race([
        Promise.all([first, second]).then(() => 'all'),
        new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 500)),
      ]);

      // The second sender was still queued when the first one failed: it
      // must be released, not left hanging on a promise that never settles.
      expect(settled).toBe('all');
      // Give the microtask queue a chance to report a floating rejection.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(failures).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps sending after a line failed', async () => {
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
