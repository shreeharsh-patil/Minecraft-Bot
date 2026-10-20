/**
 * Structured logger with hard redaction of secrets.
 *
 * Rules enforced here (rather than at every call site):
 *  - any key that looks like a credential is replaced before formatting;
 *  - bearer-ish / known-prefixed token strings are scrubbed from free text;
 *  - output goes to stdout/stderr only, never back into Minecraft chat.
 */
import { isSecretKey, REDACTED, scrubText } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger that stamps every record with extra fields. */
  child(fields: LogFields): Logger;
  readonly level: LogLevel;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: 'pretty' | 'json';
  /** Injected for tests. Defaults to console. */
  sink?: (line: string) => void;
  errorSink?: (line: string) => void;
  /** Extra fields merged into every record (e.g. bot username). */
  base?: LogFields;
  /** Injected for tests to get a stable clock. */
  now?: () => Date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads one property. A getter that throws must not take the caller down. */
function safeRead(target: object, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return '[unreadable]';
  }
}

/** Own enumerable keys of an object. A hostile proxy must not throw here. */
function ownKeys(target: object): string[] {
  try {
    return Object.keys(target);
  } catch {
    return [];
  }
}

/**
 * Defines a field on a record. `defineProperty` (not assignment) so that a
 * key such as "__proto__" becomes a field of its own instead of silently
 * swapping the prototype of the record.
 */
function setField(record: LogFields, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Coerces an unknown value to scrubbed text. Never throws. */
function safeText(value: unknown): string {
  try {
    if (typeof value === 'string') return scrubText(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return scrubText(String(value));
    }
    if (value === undefined || value === null) return '';
    return '[unserialisable]';
  } catch {
    return '[unreadable]';
  }
}

/** ISO timestamp, even when the injected clock is broken. */
function safeTimestamp(now: () => Date): string {
  try {
    const date = now();
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** Merges field layers. A hostile getter must not throw while merging. */
function mergeFields(...sources: LogFields[]): LogFields {
  const out: LogFields = {};
  for (const source of sources) {
    for (const key of ownKeys(source)) setField(out, key, safeRead(source, key));
  }
  return out;
}

/**
 * Depth-limited, cycle-safe serialisation. Prevents a hostile object graph
 * (or a mineflayer entity) from producing a multi-megabyte log line.
 *
 * It also never throws: a getter that raises, a proxy that lies or an Error
 * with a non-string message would otherwise propagate out of the logger and
 * take the caller down with it.
 */
function safeSerialize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') return scrubText(value as string);
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return (value as bigint).toString();
  if (t === 'undefined') return undefined;
  if (t === 'function' || t === 'symbol') return `[${t}]`;
  if (value instanceof Error) {
    return {
      name: safeText(safeRead(value, 'name')),
      message: safeText(safeRead(value, 'message')),
      stack: safeText(safeRead(value, 'stack')),
    };
  }
  // A Date, Map, Set or RegExp has no own enumerable fields: without this it
  // would be serialised as an empty object and the information would be lost.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[invalid date]' : value.toISOString();
  }
  if (value instanceof Map) return safeSerialize(Object.fromEntries(value), depth + 1, seen);
  if (value instanceof Set) return safeSerialize([...value], depth + 1, seen);
  if (value instanceof RegExp) return value.source;
  if (depth >= 4) return '[depth-limit]';
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const items = value.slice(0, 20).map((v) => safeSerialize(v, depth + 1, seen));
    // A sibling that points at the same array is not a cycle: only the path
    // currently being walked may be "seen".
    seen.delete(value);
    return items;
  }
  if (isPlainObject(value) || t === 'object') {
    const obj = value as object;
    if (seen.has(obj)) return '[circular]';
    seen.add(obj);
    const out: LogFields = {};
    for (const k of ownKeys(obj)) {
      const v = safeRead(obj, k);
      // Recurse: the old code only redacted the TOP level, so a nested
      // `apiKey` was printed in full and a nested circular object crashed
      // JSON.stringify inside the logger.
      // The key is scrubbed as well: a key is content too, and a key that
      // carries a newline would forge a second log line.
      setField(out, scrubText(k), isSecretKey(k) ? REDACTED : safeSerialize(v, depth + 1, seen));
    }
    seen.delete(obj);
    return out;
  }
  // Only reachable for exotic primitives (e.g. Symbol on old runtimes).
  return Object.prototype.toString.call(value);
}

const COLORS: Record<Exclude<LogLevel, 'silent'>, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};
const RESET = '\u001b[0m';

/** Safe, compact rendering of a log field value. */
function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    // Circular or non-serialisable - fall back to a type tag.
    return '[unserialisable]';
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level: LogLevel = options.level ?? 'info';
  const format = options.format ?? 'pretty';
  const now = options.now ?? (() => new Date());
  const write = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeErr = options.errorSink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const base = options.base ?? {};
  const threshold = LEVEL_WEIGHT[level];

  const make = (boundFields: LogFields): Logger => {
    const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields): void => {
      if (LEVEL_WEIGHT[lvl] < threshold) return;
      const text = safeText(msg);
      let record: LogFields;
      try {
        record = {
          // User fields come first: the reserved keys are written last so a
          // field named "level" or "ts" cannot rewrite the record's metadata.
          ...(safeSerialize(base) as LogFields),
          ...(safeSerialize(boundFields) as LogFields),
          ...(fields ? (safeSerialize(fields) as LogFields) : {}),
          ts: safeTimestamp(now),
          level: lvl,
          msg: text,
        };
      } catch {
        // A logger that throws takes the caller down with it: degrade to a
        // minimal record instead of propagating the failure.
        record = { ts: safeTimestamp(now), level: lvl, msg: text };
      }
      if (format === 'json') {
        write(JSON.stringify(record));
      } else {
        const extras: string[] = [];
        for (const [k, v] of Object.entries(record)) {
          if (k === 'ts' || k === 'level' || k === 'msg') continue;
          extras.push(`${k}=${formatValue(v)}`);
        }
        const tag = `${COLORS[lvl]}${lvl.toUpperCase().padEnd(5)}${RESET}`;
        const line =
          `${formatValue(record['ts'])} ${tag} ${formatValue(record['msg'])}` +
          `${extras.length ? ` ${extras.join(' ')}` : ''}`;
        // Errors go to stderr so container logs stay separable from normal output.
        if (lvl === 'error') writeErr(line);
        else write(line);
      }
    };

    return {
      level,
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (fields) => make(mergeFields(boundFields, fields)),
    };
  };

  return make(base);
}

/** A logger that discards everything - handy as a default parameter in tests. */
export const silentLogger: Logger = createLogger({ level: 'silent', sink: () => undefined });