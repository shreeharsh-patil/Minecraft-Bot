/**
 * Tooling-configuration audit.
 *
 * These tests pin the build / lint / test / deploy configuration so a
 * configuration mistake fails here (fast, offline) instead of in CI or on
 * Render. They only read configuration files - no production code is touched.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface PackageManifest {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as PackageManifest;

/** Every file under `dir` whose name matches `extension`. */
function filesUnder(dir: string, extension: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full, extension));
    else if (extension.test(entry.name)) found.push(full);
  }
  return found;
}

/** Module specifiers imported by a TypeScript file (static, re-export, dynamic). */
function importSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && first && ts.isStringLiteral(first)) {
        specifiers.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** The package a bare module specifier refers to, or undefined for builtins/paths. */
function packageOf(specifier: string): string | undefined {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:')
  ) {
    return undefined;
  }
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    const scope = parts[0];
    const name = parts[1];
    return scope && name ? `${scope}/${name}` : undefined;
  }
  return parts[0];
}

/** True when git would ignore `relativePath`. */
function gitIgnores(relativePath: string): boolean {
  const result = spawnSync(
    'git',
    ['check-ignore', '--no-index', '--quiet', relativePath],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.error !== undefined) return false;
  return result.status === 0;
}

/** The compiler options and file list of a tsconfig file. */
function readTsConfig(file: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(repoRoot, file),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          `${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
        );
      },
    },
  );
  if (parsed === undefined) throw new Error(`${file} could not be parsed`);
  return parsed;
}

describe('eslint configuration', () => {
  it('does not abort the lint gate on a root-level scratch TypeScript probe', async () => {
    // A throwaway script dropped at the repository root belongs to no tsconfig
    // project. The type-aware parser cannot resolve it, and ESLint then fails
    // the whole run with "was not found by the project service" instead of
    // reporting a single file - which breaks `npm run lint` and the CI gate.
    const probe = path.join(repoRoot, '.scratch-tooling-audit-probe.ts');
    writeFileSync(probe, 'export const toolingAuditProbe = 1;\n', 'utf8');
    try {
      const eslint = new ESLint({ cwd: repoRoot });
      const results = await eslint.lintFiles([probe]);
      const fatal = results
        .flatMap((result) => result.messages)
        .filter((message) => message.fatal === true)
        .map((message) => message.message);
      expect(fatal).toEqual([]);
    } finally {
      rmSync(probe, { force: true });
    }
  }, 120_000);
});

describe('dependency declarations', () => {
  it('declares every package imported by src/', () => {
    const declared = new Set([
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies),
    ]);
    const imported = new Map<string, string>();
    const sources = filesUnder(path.join(repoRoot, 'src'), /\.ts$/);
    for (const file of sources) {
      for (const specifier of importSpecifiers(file)) {
        const name = packageOf(specifier);
        if (name === undefined || declared.has(name)) continue;
        if (!imported.has(name)) {
          imported.set(name, path.relative(repoRoot, file));
        }
      }
    }
    // An undeclared import only resolves because npm happened to hoist the
    // package to the top of node_modules; a clean `npm ci` can break the build.
    expect([...imported.entries()].map(([name, file]) => `${name} (${file})`)).toEqual([]);
  }, 120_000);
});

describe('vitest configuration', () => {
  it('has the configured coverage provider installed', () => {
    const source = readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
    const match = /provider:\s*['"]([^'"]+)['"]/.exec(source);
    expect(match).not.toBeNull();
    const provider = match?.[1] ?? '';
    expect(provider).not.toBe('');
    if (provider === 'custom') return; // a custom provider is a path, not a package
    const coveragePackage = `@vitest/coverage-${provider}`;
    const declared =
      manifest.dependencies[coveragePackage] ?? manifest.devDependencies[coveragePackage];
    expect(declared, `${coveragePackage} must be a declared dependency`).toBeDefined();
    expect(
      existsSync(path.join(repoRoot, 'node_modules', coveragePackage)),
      `${coveragePackage} must be installed`,
    ).toBe(true);
  });
});

describe('git hygiene', () => {
  it('never commits the Minecraft/Microsoft auth token cache', () => {
    // render.yaml points MC_PROFILES_PATH at src/.minecraft-auth, i.e. inside
    // the tracked source tree, and native/README.md requires that the token
    // directory is never committed.
    for (const candidate of [
      path.join('src', '.minecraft-auth', 'launcher_accounts.json'),
      path.join('.minecraft-auth', 'launcher_accounts.json'),
      'launcher_accounts.json',
    ]) {
      expect(gitIgnores(candidate), `${candidate} must be gitignored`).toBe(true);
    }
  }, 60_000);
});

describe('build configuration', () => {
  it('compiles every file under src/ into dist/', () => {
    const build = readTsConfig('tsconfig.build.json');
    const compiled = new Set(build.fileNames.map((file) => path.normalize(file)));
    const missing = filesUnder(path.join(repoRoot, 'src'), /\.ts$/)
      .filter((file) => !compiled.has(path.normalize(file)))
      .map((file) => path.relative(repoRoot, file));
    expect(missing).toEqual([]);
  });

  it('keeps the tests out of the published build', () => {
    const build = readTsConfig('tsconfig.build.json');
    const testFiles = build.fileNames.filter((file) =>
      path.normalize(file).includes(`${path.sep}tests${path.sep}`),
    );
    expect(testFiles).toEqual([]);
  });
});

describe('package scripts', () => {
  it('points every script at a file that exists or that the build produces', () => {
    const build = readTsConfig('tsconfig.build.json');
    const rootDir = build.options.rootDir ?? path.join(repoRoot, 'src');
    const outDir = build.options.outDir ?? path.join(repoRoot, 'dist');
    const produced = new Set<string>();
    for (const file of build.fileNames) {
      const relative = path.relative(rootDir, file);
      if (relative.startsWith('..')) continue;
      produced.add(path.normalize(path.join(outDir, relative)).replace(/\.ts$/, '.js'));
    }

    const missing: string[] = [];
    for (const [name, command] of Object.entries(manifest.scripts)) {
      for (const token of command.split(/\s+/)) {
        if (!/\.(ts|js|json)$/.test(token)) continue;
        const absolute = path.resolve(repoRoot, token);
        if (existsSync(absolute) || produced.has(path.normalize(absolute))) continue;
        missing.push(`${name}: ${token}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
