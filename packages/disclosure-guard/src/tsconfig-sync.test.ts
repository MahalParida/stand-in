import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// tsconfig.standalone.json duplicates the monorepo's tsconfig.base.json so the
// package can build in its own repository. Inside the monorepo, fail if they drift.
const here = dirname(fileURLToPath(import.meta.url));
const basePath = resolve(here, '../../../tsconfig.base.json');
const standalonePath = resolve(here, '../tsconfig.standalone.json');
// Only run inside the Stand-In monorepo: <root>/packages/disclosure-guard with
// <root>/pnpm-workspace.yaml. A stray tsconfig.base.json above a standalone
// clone must not make this test run.
const repoRoot = resolve(here, '../../..');
const inMonorepo =
  existsSync(basePath) &&
  existsSync(resolve(repoRoot, 'pnpm-workspace.yaml')) &&
  resolve(here, '..') === resolve(repoRoot, 'packages/disclosure-guard');
const PACKAGE_ONLY = new Set(['rootDir', 'outDir', 'tsBuildInfoFile']);

describe('tsconfig.standalone.json', () => {
  it.skipIf(!inMonorepo)('matches the monorepo tsconfig.base.json compiler options', () => {
    const base = JSON.parse(readFileSync(basePath, 'utf8')) as { compilerOptions: Record<string, unknown> };
    const standalone = JSON.parse(readFileSync(standalonePath, 'utf8')) as {
      compilerOptions: Record<string, unknown>;
    };
    const shared = Object.fromEntries(
      Object.entries(standalone.compilerOptions).filter(([k]) => !PACKAGE_ONLY.has(k)),
    );
    expect(shared).toEqual(base.compilerOptions);
  });
});
