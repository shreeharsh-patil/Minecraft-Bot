/**
 * Deployment-surface and documentation audit.
 *
 * These checks keep the deployment files (`.env.example`,
 * `.env.native.example`, `render.yaml`, `Dockerfile`) and the README honest
 * about the code they configure. They fail when:
 *
 *  - a variable the config reads is missing from the shipped env example, or
 *    the example documents a variable nothing ever reads;
 *  - the Render blueprint does not provide a variable the bot refuses to
 *    start without;
 *  - the README claims something the code, the lockfile or the Dockerfile
 *    contradicts (Node.js floor, "the Dockerfile targets Node", "an API key is
 *    required", the size of the closed action allowlist).
 *
 * The native runtime has its own env example and its own config; both are
 * covered here too.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

/** Keys declared in a dotenv-style example file (commented lines included). */
function exampleKeys(file: string): Set<string> {
  const keys = new Set<string>();
  for (const line of read(file).split(/\r?\n/)) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

/**
 * Upper-case string literals of a source file. In `src/config/config.ts` and
 * in `native/src/config.rs` every one of them is an environment variable name.
 */
function uppercaseLiterals(file: string): Set<string> {
  const keys = new Set<string>();
  for (const match of read(file).matchAll(/'([A-Z][A-Z0-9_]*)'/g)) {
    if (match[1]) keys.add(match[1]);
  }
  return keys;
}

/**
 * Environment variables the native config reads. The provider key/model names
 * are built at runtime (`format!("{pre}_MODEL")`), so they are added here.
 */
function nativeConfigKeys(): Set<string> {
  const text = read('native/src/config.rs');
  const keys = new Set<string>();
  for (const match of text.matchAll(/(?:get|required|num)\(\s*"([A-Z][A-Z0-9_]*)"/g)) {
    if (match[1]) keys.add(match[1]);
  }
  for (const match of text.matchAll(/"(groq|gemini|openai|openrouter)"/g)) {
    if (!match[1]) continue;
    const prefix = match[1].toUpperCase();
    keys.add(`${prefix}_MODEL`);
    keys.add(`${prefix}_API_KEY`);
    keys.add(`${prefix}_API_KEYS`);
  }
  return keys;
}

/**
 * Variables the bot refuses to start without. `req()` marks them directly;
 * `AUTHORIZED_PLAYERS` is validated separately (an empty list is an issue).
 */
function requiredConfigKeys(): Set<string> {
  const text = read('src/config/config.ts');
  const keys = new Set<string>();
  for (const match of text.matchAll(/\breq\(\s*env\s*,\s*'([A-Z][A-Z0-9_]*)'/g)) {
    if (match[1]) keys.add(match[1]);
  }
  if (text.includes("'AUTHORIZED_PLAYERS is required")) keys.add('AUTHORIZED_PLAYERS');
  return keys;
}

/** Keys of the `envVars` list in the Render blueprint. */
function renderEnvKeys(): Set<string> {
  const keys = new Set<string>();
  const yaml = read('render.yaml');
  const envSection = yaml.slice(yaml.indexOf('envVars:'));
  for (const match of envSection.matchAll(/^\s*-\s*key:\s*([A-Z][A-Z0-9_]*)\s*$/gm)) {
    if (match[1]) keys.add(match[1]);
  }
  return keys;
}

/** The strictest Node.js floor demanded by a runtime dependency. */
function requiredNodeMajor(): number {
  const lock = JSON.parse(read('package-lock.json')) as {
    packages?: Record<string, { dev?: boolean; engines?: { node?: string } }>;
  };
  let major = 0;
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (path === '' || meta.dev === true) continue;
    const match = meta.engines?.node ? />=\s*(\d+)/.exec(meta.engines.node) : null;
    if (match?.[1]) major = Math.max(major, Number(match[1]));
  }
  return major;
}

/** The number of entries in the closed action allowlist. */
function actionTypeCount(): number {
  const source = read('src/types/actions.ts');
  const block = /ACTION_TYPES\s*=\s*(?:Object\.freeze\(\s*)?\[([\s\S]*?)\]/.exec(source);
  return (block?.[1]?.match(/'[a-z_]+'/g) ?? []).length;
}

describe('environment examples', () => {
  it('documents every environment variable the bot reads', () => {
    const documented = exampleKeys('.env.example');
    // Platform markers only answer "am I on a PaaS?"; they are not settings.
    const platformMarkers = ['RENDER', 'DYNO', 'HEROKU', 'RAILWAY_ENVIRONMENT', 'FLY_APP_NAME'];
    const missing = [...uppercaseLiterals('src/config/config.ts')].filter(
      (key) => !documented.has(key) && !platformMarkers.includes(key),
    );
    expect(missing).toEqual([]);
  });

  it('documents no environment variable the bot never reads', () => {
    const readKeys = uppercaseLiterals('src/config/config.ts');
    const extra = [...exampleKeys('.env.example')].filter((key) => !readKeys.has(key));
    expect(extra).toEqual([]);
  });

  it('keeps .env.native.example in sync with the native config', () => {
    const documented = exampleKeys('.env.native.example');
    const nativeKeys = nativeConfigKeys();
    expect([...nativeKeys].filter((key) => !documented.has(key))).toEqual([]);
    expect([...documented].filter((key) => !nativeKeys.has(key))).toEqual([]);
  });

  it('does not report a fresh npm install as broken while it installs cleanly', () => {
    const stale = /@types\/mineflayer-pathfinder/.test(read('package.json') + read('package-lock.json'));
    if (stale) return; // The dependency is still there - the old note is accurate.
    const historical = /at that baseline|has since been removed|since been removed|no longer|historical/i;
    for (const doc of ['docs/testing.md', 'docs/validation.md']) {
      const sentences = read(doc)
        .split(/(?<=[.\n])/)
        .filter((sentence) => /npm (ci|install)/i.test(sentence));
      for (const sentence of sentences) {
        if (!/\bfail/i.test(sentence)) continue;
        // A failure may only be reported as an already-fixed historical fact.
        expect(sentence).toMatch(historical);
      }
    }
  });
});

describe('Render blueprint', () => {
  it('provides every variable the bot refuses to start without', () => {
    const provided = renderEnvKeys();
    expect([...requiredConfigKeys()].filter((key) => !provided.has(key))).toEqual([]);
  });

  it('only sets variables the bot (or the platform) understands', () => {
    const known = uppercaseLiterals('src/config/config.ts');
    known.add('NODE_VERSION'); // Render's own Node.js pin.
    const unknown = [...renderEnvKeys()].filter((key) => !known.has(key));
    expect(unknown).toEqual([]);
  });
});

describe('README claims', () => {
  const readme = read('README.md');
  const flat = readme.replace(/\s+/g, ' ');

  it('does not claim the Dockerfile builds the Node bot', () => {
    const dockerfile = read('Dockerfile');
    // The image is a Debian build of the Rust companion: no Node, no npm.
    expect(dockerfile).not.toMatch(/\b(node|npm|nvm)\b/i);
    const mentions = readme.split(/(?<=[.\n])/).filter((part) => /Dockerfile/.test(part));
    expect(mentions.length).toBeGreaterThan(0);
    // Every mention has to describe what the image really contains.
    expect(mentions.some((part) => /rust|companion/i.test(part))).toBe(true);
    expect(mentions.some((part) => /\bNode\b/i.test(part) && /\btargets?\b/i.test(part))).toBe(false);
  });

  it('documents a Node.js floor the runtime dependencies support', () => {
    const required = requiredNodeMajor();
    expect(required).toBeGreaterThan(0);
    const stated = /Node\.js\s*>=\s*(\d+(?:\.\d+)?)/.exec(flat);
    expect(stated?.[1]).toBeDefined();
    expect(Number(stated?.[1])).toBeGreaterThanOrEqual(required);
  });

  it('does not tell the reader that an AI API key is required', () => {
    expect(flat).not.toMatch(/at least one provider API key/i);
    expect(flat).toMatch(/AI_LOCAL_PLANNER=true/);
  });

  it('states the real size of the closed action allowlist', () => {
    const count = actionTypeCount();
    expect(count).toBeGreaterThan(0);
    const stated = /one of (\d+) typed action shapes/.exec(flat);
    expect(stated?.[1]).toBeDefined();
    expect(Number(stated?.[1])).toBe(count);
  });
});
