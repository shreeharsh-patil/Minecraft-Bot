/**
 * Type-contract audit for the memory store, the provider contract and the
 * types barrel.
 *
 * The defects behind these tests are TYPE level, so the regression checks
 * are type level too: a probe snippet is compiled with the TypeScript
 * compiler API and must (or must not) produce a diagnostic. A probe that
 * has to stop compiling therefore fails the test when the contract weakens
 * again - which a plain runtime assertion could not catch.
 *
 * Covered:
 *  1. the memory store hands out a read-only view of the live session, so
 *     the rolling-window caps cannot be bypassed from the outside;
 *  2. `ProviderError.retryable` matches its own documentation;
 *  3. `ProviderStats` is a snapshot, so it cannot be written to;
 *  4. the types barrel re-exports every type module.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ProviderError } from '../../src/types/provider.js';
import { createMemoryStore } from '../../src/ai/memory.js';
import { MAX_RECENT_FAILURES, MAX_RECENT_INSTRUCTIONS } from '../../src/types/memory.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE_DIR = path.join(REPO_ROOT, 'tests', 'audit');

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noUncheckedIndexedAccess: true,
  noEmit: true,
  skipLibCheck: true,
  // Only the libs the type modules actually need: the DOM lib supplies
  // `AbortSignal` for the provider contract, and skipping @types/node keeps
  // the probe run fast.
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  types: [],
};

/**
 * Compiles every probe as its own module and returns the compiler errors
 * per probe name.
 *
 * The probes are virtual files that live next to this test, so their
 * relative imports (`../../src/types/memory.js`) resolve exactly like a
 * real test file would.
 */
function compileProbes(probes: Record<string, string>): Record<string, string[]> {
  const sources = new Map<string, string>();
  for (const [name, code] of Object.entries(probes)) {
    sources.set(path.join(PROBE_DIR, `__probe_${name}__.ts`), code);
  }

  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const code = sources.get(path.resolve(fileName));
    if (code !== undefined) return ts.createSourceFile(fileName, code, languageVersion, true);
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => sources.has(path.resolve(fileName)) || originalFileExists(fileName);
  const originalReadFile = host.readFile.bind(host);
  host.readFile = (fileName) => sources.get(path.resolve(fileName)) ?? originalReadFile(fileName);

  const program = ts.createProgram([...sources.keys()], COMPILER_OPTIONS, host);

  const byFile = new Map<string, string[]>();
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (diagnostic.file === undefined) continue;
    const key = path.basename(diagnostic.file.fileName);
    const messages = byFile.get(key) ?? [];
    messages.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
    byFile.set(key, messages);
  }

  const result: Record<string, string[]> = {};
  for (const name of Object.keys(probes)) {
    result[name] = byFile.get(`__probe_${name}__.ts`) ?? [];
  }
  return result;
}

const MEMORY_IMPORT = "import type { MemoryStore } from '../../src/types/memory.js';";
const STATS_IMPORT = "import type { ProviderStats } from '../../src/types/provider.js';";

/** Every probe of the file; they are compiled in one go, in one program. */
const PROBES: Record<string, string> = {
  // A probe that must compile cleanly; it guards the probes below it.
  memoryControl: `
${MEMORY_IMPORT}
declare const store: MemoryStore;
export function read(): number {
  const session = store.shortTerm;
  return session.recentInstructions.length
    + session.recentFailures.length
    + session.recentLocations.length
    + session.conversation.length
    + (session.objective?.length ?? 0)
    + (session.targetPlayer?.length ?? 0);
}
`,
  pushInstruction: `
${MEMORY_IMPORT}
declare const store: MemoryStore;
export function push(): void {
  store.shortTerm.recentInstructions.push({ player: 'Alice', text: 'hi', at: 0 });
}
`,
  pushFailure: `
${MEMORY_IMPORT}
declare const store: MemoryStore;
export function push(): void {
  store.shortTerm.recentFailures.push({ action: 'plan', reason: 'nope', at: 0 });
}
`,
  pushConversation: `
${MEMORY_IMPORT}
declare const store: MemoryStore;
export function push(): void {
  store.shortTerm.conversation.push({ player: 'Alice', text: 'hi', at: 0 });
}
`,
  pushLocation: `
${MEMORY_IMPORT}
declare const store: MemoryStore;
export function push(): void {
  store.shortTerm.recentLocations.push({ name: 'home', position: { x: 1, y: 2, z: 3 }, resolved: true, createdAt: 0 });
}
`,
  replaceWindow: `
${MEMORY_IMPORT}
declare const store: MemoryStore;
export function replace(): void {
  store.shortTerm.recentInstructions = [];
}
`,
  writeObjective: `
${MEMORY_IMPORT}
declare const store: MemoryStore;
export function write(): void {
  store.shortTerm.objective = 'mine diamonds';
}
`,
  statsControl: `
${STATS_IMPORT}
declare const stats: ProviderStats;
export function read(): string {
  return \`\${stats.name}:\${stats.circuit.state}:\${stats.successes}/\${stats.requests}\`;
}
`,
  writeCounter: `
${STATS_IMPORT}
declare const stats: ProviderStats;
export function write(): void {
  stats.requests = 0;
}
`,
  writeCircuit: `
${STATS_IMPORT}
declare const stats: ProviderStats;
export function write(): void {
  stats.circuit.state = 'open';
}
`,
  barrelValues: `
import * as types from '../../src/types/index.js';

export const probe: number[] = [
  types.ACTION_TYPES.length,
  types.isActionType('stop') ? 1 : 0,
  Math.round(types.distance3({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })),
  types.roundPos({ x: 1.234, y: 2.345, z: 3.456 }).x,
  types.TASK_STATUSES.length,
  types.isTerminalStatus('completed') ? 1 : 0,
  types.MAX_RECENT_INSTRUCTIONS,
  types.MAX_RECENT_FAILURES,
  types.MAX_RECENT_LOCATIONS,
];
`,
  barrelTypes: `
import type {
  ActionType,
  MemoryStore,
  MinecraftFacade,
  ProviderCircuit,
  ProviderStats,
  Skill,
  Vec3Like,
} from '../../src/types/index.js';

export type Probe = [
  ActionType,
  MemoryStore,
  MinecraftFacade,
  ProviderCircuit,
  ProviderStats,
  Skill<ActionType>,
  Vec3Like,
];
`,
  barrelProviderError: `
import { ProviderError } from '../../src/types/index.js';

export const error: ProviderError = new ProviderError('groq', 'timeout', 'boom');
`,
};

/** Compiling the probes is expensive, so it happens once for the file. */
let probeErrors: Record<string, string[]> = {};

beforeAll(() => {
  probeErrors = compileProbes(PROBES);
}, 120_000);

describe('memory contract - the session is a read-only view', () => {
  it('refuses to let a caller grow or rewrite the rolling windows', () => {
    // The control must compile, otherwise the probes below prove nothing.
    expect(probeErrors.memoryControl).toEqual([]);

    expect(probeErrors.pushInstruction).not.toEqual([]);
    expect(probeErrors.pushFailure).not.toEqual([]);
    expect(probeErrors.pushConversation).not.toEqual([]);
    expect(probeErrors.pushLocation).not.toEqual([]);
    expect(probeErrors.replaceWindow).not.toEqual([]);
    expect(probeErrors.writeObjective).not.toEqual([]);
  });

  it('still caps the rolling windows at runtime', () => {
    const store = createMemoryStore({ conversationTurns: 3 });
    for (let i = 0; i < 25; i += 1) {
      store.noteInstruction('Alice', `do ${i}`);
      store.noteFailure('plan', `failed ${i}`);
      store.noteConversation('Alice', `chat ${i}`);
    }

    expect(store.shortTerm.recentInstructions).toHaveLength(MAX_RECENT_INSTRUCTIONS);
    expect(store.shortTerm.recentFailures).toHaveLength(MAX_RECENT_FAILURES);
    expect(store.shortTerm.conversation).toHaveLength(3);
  });
});

describe('provider error contract - retryable matches its documentation', () => {
  it('is false for the kinds a retry can never fix', () => {
    // Rejected credentials, a malformed request and a cancelled attempt all
    // stay broken when the very same request is sent again.
    expect(new ProviderError('openai', 'auth', 'openai: credentials rejected').retryable).toBe(false);
    expect(new ProviderError('openai', 'invalid_request', 'openai: bad request').retryable).toBe(false);
    expect(new ProviderError('openai', 'aborted', 'openai: request cancelled by caller').retryable).toBe(false);
  });

  it('is true for the kinds a retry can plausibly fix', () => {
    const transient: Array<'rate_limited' | 'timeout' | 'network' | 'server_error' | 'parse_error' | 'unknown'> = [
      'rate_limited',
      'timeout',
      'network',
      'server_error',
      'parse_error',
      'unknown',
    ];
    for (const kind of transient) {
      expect(new ProviderError('groq', kind, `groq: ${kind}`).retryable).toBe(true);
    }
  });

  it('lets an explicit retryable override win', () => {
    expect(new ProviderError('openai', 'auth', 'openai: 401', { retryable: true }).retryable).toBe(true);
    expect(new ProviderError('openai', 'network', 'openai: boom', { retryable: false }).retryable).toBe(false);
  });
});

describe('provider stats contract - a snapshot cannot be written to', () => {
  it('refuses to let a caller mutate the rolled-out statistics', () => {
    expect(probeErrors.statsControl).toEqual([]);
    expect(probeErrors.writeCounter).not.toEqual([]);
    expect(probeErrors.writeCircuit).not.toEqual([]);
  });
});

describe('types barrel', () => {
  it('re-exports every type module without a missing or ambiguous name', () => {
    expect(probeErrors.barrelValues).toEqual([]);
    expect(probeErrors.barrelTypes).toEqual([]);
    expect(probeErrors.barrelProviderError).toEqual([]);
  });
});
