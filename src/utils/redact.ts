/**
 * Secret redaction. Applied by the logger (and asserted by tests) so that an
 * API key or Minecraft access token can never reach a log file or a chat reply.
 */

/**
 * Property names whose values must never be printed.
 *
 * Implemented as token matching rather than one large regex: a key is split on
 * `_`, `-`, `.` and camelCase boundaries, and is secret when it contains a
 * credential word ("token", "secret", "password" ...) on its own or alongside a
 * qualifier ("api", "private", "refresh"). This handles `API_KEY`, `api-key`,
 * `x-api-key`, `apiKey` and `GROQ_API_KEY` uniformly, while leaving ordinary
 * names such as `username` or `model` alone.
 */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'key',
  'mctoken',
  'msatoken',
  'otp',
  'passwd',
  'password',
  'pin',
  'privatekey',
  'secret',
  'session',
  'token',
]);

/** Words that only imply a credential when paired with another word. */
const SECRET_QUALIFIERS: ReadonlySet<string> = new Set([
  'api',
  'access',
  'client',
  'mc',
  'minecraft',
  'msa',
  'private',
  'refresh',
  'x',
]);

/** Splits a key into lowercase word tokens. */
function tokenizeKey(key: string): string[] {
  return key
    // split camelCase / PascalCase boundaries
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    // split on separators
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
}

/** Free-text token shapes that indicate a credential regardless of context. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, // openai-style
  /\bgsk_[A-Za-z0-9_-]{16,}\b/g, // groq
  /\bAIza[A-Za-z0-9_-]{20,}\b/g, // google
  /\bsk-or-v1-[A-Za-z0-9]{16,}\b/g, // openrouter
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // jwt
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // uuid-ish tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\bMCToken:[A-Za-z0-9+/=._-]{20,}/gi,
];

export const REDACTED = '[REDACTED]';

export function isSecretKey(key: string): boolean {
  const words = tokenizeKey(key);
  if (words.length === 0) return false;

  // A bare qualifier ("api") is not on its own a credential name.
  if (words.every((word) => SECRET_QUALIFIERS.has(word))) return false;

  return words.some((word) => SECRET_WORDS.has(word));
}

/** Redacts a value if its key looks sensitive; otherwise recurses into objects. */
export function redactValue(key: string, value: unknown): unknown {
  if (isSecretKey(key)) return REDACTED;
  if (typeof value === 'string') return scrubText(value);
  return value;
}

/** Scrubs credential-looking substrings out of arbitrary text. */
export function scrubText(input: string): string {
  // Control characters first: a newline inside a value would forge a second
  // log line, and a terminal escape could rewrite the console.
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  let out = input.replace(/[\u0000-\u001F\u007F]/g, ' ');
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  // KEY=value style pairs, e.g. GROQ_API_KEY=abc123
  out = out.replace(
    /([A-Z0-9_]*(?:API_KEY|SECRET|PASSWORD|TOKEN|ACCESS)[A-Z0-9_]*)\s*=\s*[^\s,;]+/gi,
    `$1=${REDACTED}`,
  );
  return out;
}

/**
 * Defence in depth for anything headed into Minecraft chat.
 * Also refuses to echo filesystem-looking paths.
 */
export function scrubForChat(input: string): string {
  let out = scrubText(input);
  // A real path: a Windows drive ("C:\Users\me") or an absolute path
  // ("/home/me/x"). A bare slash between words ("drop/stash/withdraw") is
  // ordinary prose and must survive - redacting it mangled the bot's own
  // capability list.
  out = out.replace(/[A-Za-z]:\\(?:[\w.\\-]+[\\/])*[\w.\\-]*/g, '[path redacted]');
  // The slash must START the path (not continue a word): "drop/stash" is
  // prose, "/home/me" is a path.
  out = out.replace(/(?<![\w])\/(?:[\w.-]+\/)+[\w.-]*/g, '[path redacted]');
  out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, 'host');
  return out;
}