/**
 * Structured logger with hard redaction of secrets.
 *
 * Rules enforced here (rather than at every call site):
 *  - any key that looks like a credential is replaced before formatting;
 *  - bearer-ish / known-prefixed token strings are scrubbed from free text;
 *  - output goes to stdout/stderr only, never back into Minecraft chat.
 */
import { redactValue, scrubText } from './redact.js';

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

/**
 * Depth-limited, cycle-safe serialisation. Prevents a hostile object graph
 * (or a mineflayer entity) from producing a multi-megabyte log line.
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
    return { name: value.name, message: scrubText(value.message), stack: scrubText(value.stack ?? '') };
  }
  if (depth >= 4) return '[depth-limit]';
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value.slice(0, 20).map((v) => safeSerialize(v, depth + 1, seen));
  }
  if (isPlainObject(value) || t === 'object') {
    const obj = value as object;
    if (seen.has(obj)) return '[circular]';
    seen.add(obj);
    const out: LogFields = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v);
    }
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
      const record: LogFields = {
        ts: now().toISOString(),
        level: lvl,
        msg: scrubText(msg),
        ...safeSerialize({ ...base, ...boundFields }) as LogFields,
        ...(fields ? (safeSerialize(fields) as LogFields) : {}),
      };
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
      child: (fields) => make({ ...boundFields, ...fields }),
    };
  };

  return make(base);
}

/** A logger that discards everything - handy as a default parameter in tests. */
export const silentLogger: Logger = createLogger({ level: 'silent', sink: () => undefined });