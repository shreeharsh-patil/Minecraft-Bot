/**
 * The logger is the last place a secret can leak from, so it must redact at
 * every depth - and it must never throw while logging (a logger that crashes
 * takes the caller down with it).
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/utils/logger.js';

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

describe('logger - redaction', () => {
  it('redacts a secret at the top level', () => {
    const { logger, lines } = capture();
    logger.info('config', { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345' });
    expect(lines[0]).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(lines[0]).toContain('[REDACTED]');
  });

  it('redacts a secret nested inside an object', () => {
    const { logger, lines } = capture();
    logger.info('config', { meta: { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345' } });
    expect(lines[0]).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(lines[0]).toContain('[REDACTED]');
  });

  it('redacts a secret nested inside an array of objects', () => {
    const { logger, lines } = capture();
    logger.info('config', { providers: [{ name: 'groq', apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz01' }] });
    expect(lines[0]).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz01');
  });

  it('does not throw on a circular structure', () => {
    const { logger, lines } = capture();
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;
    expect(() => logger.info('circular', { circular })).not.toThrow();
    expect(lines[0] ?? '').toContain('[circular]');
  });

  it('strips newlines so a value cannot forge a second log line', () => {
    const { logger, lines } = capture();
    logger.info('player', { player: 'Notch\nERROR fake line' });
    expect(lines).toHaveLength(1);
    expect(lines[0] ?? '').not.toContain('fake line\n');
  });

  it('does not let a field overwrite the record metadata', () => {
    const { logger, lines } = capture();
    logger.info('real message', { level: 'error', ts: 'forged' });
    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed['level']).toBe('info');
    expect(parsed['ts']).not.toBe('forged');
    expect(parsed['msg']).toBe('real message');
  });
});
