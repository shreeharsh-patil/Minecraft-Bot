/**
 * Audit of the logger and the redaction helpers.
 *
 * The logger is the last place a secret can leak from and the bot's chat is
 * public, so these tests pin down the invariants that were previously only
 * documented:
 *  - a record is exactly one line: neither a value nor a key may forge a
 *    second one;
 *  - logging never throws, whatever the caller passes in;
 *  - a credential is redacted by the shape of its key AND by the shape of its
 *    value, at every depth;
 *  - redaction does not eat ordinary prose.
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/utils/logger.js';
import { isSecretKey, REDACTED, scrubText } from '../../src/utils/redact.js';

function capture(format: 'pretty' | 'json' = 'json'): {
  logger: ReturnType<typeof createLogger>;
  lines: string[];
} {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    format,
    sink: (line) => lines.push(line),
    errorSink: (line) => lines.push(line),
  });
  return { logger, lines };
}

describe('logger - a record is exactly one line', () => {
  it('does not let a key with a newline forge a second log line', () => {
    const { logger, lines } = capture('pretty');

    logger.info('hello', { 'evil\nERROR forged line': 'x' });

    const line = lines[0] ?? '';
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect(lines).toHaveLength(1);
  });

  it('does not let a key smuggle an ANSI escape into the terminal', () => {
    const { logger, lines } = capture('pretty');

    logger.info('hello', { '\u001b[31mred\u001b[0m': 'x' });

    expect(lines[0] ?? '').not.toContain('\u001b[31m');
  });

  it('keeps the reserved metadata intact when a key is scrubbed', () => {
    const { logger, lines } = capture('json');

    logger.info('real message', { 'we\nird': 1, level: 'error', ts: 'forged' });

    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed['level']).toBe('info');
    expect(parsed['ts']).not.toBe('forged');
    expect(parsed['msg']).toBe('real message');
  });
});

describe('logger - logging never throws', () => {
  it('survives a field whose getter throws', () => {
    const { logger, lines } = capture('json');
    const hostile: Record<string, unknown> = { kept: 'yes' };
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });

    expect(() => logger.info('hello', { hostile })).not.toThrow();
    expect(lines[0] ?? '').toContain('kept');
  });

  it('survives an Error whose message is not a string', () => {
    const { logger, lines } = capture('json');
    const error = new Error('boom') as unknown as { message: unknown };
    error.message = 42;

    expect(() => logger.info('hello', { error })).not.toThrow();
    expect(lines[0] ?? '').toContain('42');
  });

  it('survives a child logger built from a hostile field', () => {
    const { logger, lines } = capture('json');
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });

    expect(() => logger.child(hostile).info('hello')).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe('logger - field serialisation', () => {
  it('keeps a Date instead of printing an empty object', () => {
    const { logger, lines } = capture('json');

    logger.info('when', { at: new Date('2020-01-02T03:04:05.000Z') });

    expect(lines[0] ?? '').toContain('2020-01-02T03:04:05.000Z');
  });

  it('keeps a field named __proto__ as a field of its own', () => {
    const { logger, lines } = capture('json');
    const fields = JSON.parse('{"__proto__":{"polluted":true},"ok":2}') as Record<string, unknown>;

    logger.info('proto', fields);

    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(Object.hasOwn(parsed, 'ok')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('does not call a shared (non-circular) reference circular', () => {
    const { logger, lines } = capture('json');
    const shared = { a: 1 };

    logger.info('dag', { one: shared, two: shared });

    expect(lines[0] ?? '').not.toContain('[circular]');
    expect(lines[0] ?? '').toContain('"a":1');
  });

  it('still reports a real cycle as circular', () => {
    const { logger, lines } = capture('json');
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;

    expect(() => logger.info('circular', { circular })).not.toThrow();
    expect(lines[0] ?? '').toContain('[circular]');
  });
});

describe('redaction - credential key shapes', () => {
  it('treats a key with a trailing index as a credential', () => {
    expect(isSecretKey('apiKey2')).toBe(true);
    expect(isSecretKey('token1')).toBe(true);
    expect(isSecretKey('password2')).toBe(true);
    expect(isSecretKey('key2')).toBe(true);
  });

  it('redacts the value of a credential key with a trailing index', () => {
    const { logger, lines } = capture('json');

    logger.info('cfg', { apiKey2: 'hunter2-not-a-known-token-shape' });

    expect(lines[0] ?? '').not.toContain('hunter2-not-a-known-token-shape');
    expect(lines[0] ?? '').toContain(REDACTED);
  });

  it('recognises the remaining credential words', () => {
    expect(isSecretKey('passphrase')).toBe(true);
    expect(isSecretKey('pwd')).toBe(true);
    expect(isSecretKey('bearer')).toBe(true);
  });

  it('still leaves ordinary names alone', () => {
    for (const name of ['username', 'host', 'port', 'model', 'count', 'blockName', 'utf8']) {
      expect(isSecretKey(name), name).toBe(false);
    }
  });
});

describe('redaction - credential value shapes', () => {
  it('scrubs well-known prefixed tokens', () => {
    // The tokens are assembled from fragments on purpose: a literal that
    // looks exactly like a real credential would trip the repository's
    // secret-scanning push protection. The shape is what matters here.
    const secrets = [
      ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_'),
      ['github', 'pat', '11ABCDEFG0abcdefghijklmnopqrstuvwxyz'].join('_'),
      ['glpat', 'abcdefghijklmnopqrstuvwxyz012345'].join('_'),
      ['xoxb', '123456789012-1234567890123-abcdefghijklmnop'].join('-'),
      ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
      ['npm', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_'),
      ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_'),
      ['ya29', 'a0AfH6SMBxabcdefghijklmnop'].join('.'),
    ];

    for (const secret of secrets) {
      const scrubbed = scrubText(`the value is ${secret} ok`);
      expect(scrubbed, secret).toContain(REDACTED);
      expect(scrubbed, secret).not.toContain(secret);
    }
  });

  it('scrubs the body of a PEM private key', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7Vb8ExAMPLEKEYMATERIAL\n-----END RSA PRIVATE KEY-----';

    const scrubbed = scrubText(pem);

    expect(scrubbed).not.toContain('MIIEowIBAAKCAQEAx7Vb8ExAMPLEKEYMATERIAL');
    expect(scrubbed).toContain(REDACTED);
  });

  it('scrubs a quoted KEY=value secret whole', () => {
    const scrubbed = scrubText('DB_PASSWORD="correct horse battery staple"');

    expect(scrubbed).not.toContain('horse');
    expect(scrubbed).not.toContain('staple');
    expect(scrubbed).toContain(REDACTED);
  });

  it('still leaves ordinary prose alone', () => {
    expect(scrubText('mining 16 oak logs')).toBe('mining 16 oak logs');
    expect(scrubText('coordinates 100 64 -20')).toBe('coordinates 100 64 -20');
    expect(scrubText('AKIA is not a token')).toBe('AKIA is not a token');
  });
});
