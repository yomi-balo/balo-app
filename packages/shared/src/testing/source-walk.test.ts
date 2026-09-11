import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listSourceFiles, scanMentioningFiles, toDisplayPath } from './source-walk';

/**
 * `source-walk.ts` is the shared filesystem walker behind every structural-invariant suite
 * that source-scans `apps/*`/`packages/*` for a property that must hold across trees
 * (`packages/db/src/invariants/admin-alert-kinds-have-exactly-one-writer.test.ts` and
 * `admin-alert-facts-are-not-fee-concealed.test.ts` today). A BUG HERE FAILS OPEN the same
 * way `stripComments` does: under-walking silently drops a file an invariant should have
 * scanned, and a broken test-file/skip-dir filter can make a real violation invisible. It is
 * worth its own tests for that reason.
 *
 * Exercised against a REAL temp directory tree (not a mocked `fs`) — the walk's whole job is
 * directory recursion and file-type filtering, which a mock would just re-describe.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'source-walk-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relPath: string, content: string): string {
  const abs = path.join(root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

describe('listSourceFiles', () => {
  it('finds .ts and .tsx source files under the given roots, recursively', () => {
    write('pkg/src/a.ts', 'export const a = 1;');
    write('pkg/src/nested/b.tsx', 'export const B = () => null;');

    const files = listSourceFiles({ repoRoot: root, rootNames: ['pkg/src'] });

    expect(files.sort()).toEqual(
      [path.join(root, 'pkg/src/a.ts'), path.join(root, 'pkg/src/nested/b.tsx')].sort()
    );
  });

  it('excludes .test.ts, .test.tsx, .spec.ts and .spec.tsx files', () => {
    write('pkg/src/a.ts', 'x');
    write('pkg/src/a.test.ts', 'x');
    write('pkg/src/a.test.tsx', 'x');
    write('pkg/src/a.spec.ts', 'x');
    write('pkg/src/a.spec.tsx', 'x');

    const files = listSourceFiles({ repoRoot: root, rootNames: ['pkg/src'] });

    expect(files).toEqual([path.join(root, 'pkg/src/a.ts')]);
  });

  it('excludes non-.ts/.tsx files (e.g. .json, .md)', () => {
    write('pkg/src/a.ts', 'x');
    write('pkg/src/readme.md', 'x');
    write('pkg/src/data.json', '{}');

    const files = listSourceFiles({ repoRoot: root, rootNames: ['pkg/src'] });

    expect(files).toEqual([path.join(root, 'pkg/src/a.ts')]);
  });

  it('skips node_modules, dist, .next and any coverage* directory', () => {
    write('pkg/src/a.ts', 'x');
    write('pkg/src/node_modules/vendor.ts', 'x');
    write('pkg/src/dist/built.ts', 'x');
    write('pkg/src/.next/gen.ts', 'x');
    write('pkg/src/coverage/report.ts', 'x');
    write('pkg/src/coverage-html/report.ts', 'x');

    const files = listSourceFiles({ repoRoot: root, rootNames: ['pkg/src'] });

    expect(files).toEqual([path.join(root, 'pkg/src/a.ts')]);
  });

  it('excludes selfPath when given, even though it matches every other filter', () => {
    const self = write('pkg/src/self.ts', 'x');
    write('pkg/src/other.ts', 'x');

    const files = listSourceFiles({ repoRoot: root, rootNames: ['pkg/src'], selfPath: self });

    expect(files).toEqual([path.join(root, 'pkg/src/other.ts')]);
  });

  it('tolerates a root that does not exist — returns empty for that root, not a throw', () => {
    write('pkg/src/a.ts', 'x');

    const files = listSourceFiles({ repoRoot: root, rootNames: ['pkg/src', 'pkg/does-not-exist'] });

    expect(files).toEqual([path.join(root, 'pkg/src/a.ts')]);
  });

  it('walks MULTIPLE roots and concatenates their results', () => {
    write('apps/api/src/x.ts', 'x');
    write('packages/db/src/y.ts', 'y');

    const files = listSourceFiles({
      repoRoot: root,
      rootNames: ['apps/api/src', 'packages/db/src'],
    });

    expect(files.sort()).toEqual(
      [path.join(root, 'apps/api/src/x.ts'), path.join(root, 'packages/db/src/y.ts')].sort()
    );
  });
});

describe('toDisplayPath', () => {
  it('renders a path relative to repoRoot, POSIX-separated', () => {
    const abs = path.join(root, 'apps', 'api', 'src', 'thing.ts');
    expect(toDisplayPath(root, abs)).toBe('apps/api/src/thing.ts');
  });
});

describe('scanMentioningFiles', () => {
  it('returns only files whose RAW source contains the substring, case-insensitively', () => {
    write('pkg/src/hit.ts', 'const x = adminAlertsRepository;');
    write('pkg/src/miss.ts', 'const y = 1;');
    write('pkg/src/hit-upper.ts', 'const z = ADMINALERT_THING;');

    const found = scanMentioningFiles(
      { repoRoot: root, rootNames: ['pkg/src'] },
      'adminalert',
      (s) => s
    );

    expect(found.map((f) => f.displayPath).sort()).toEqual([
      'pkg/src/hit-upper.ts',
      'pkg/src/hit.ts',
    ]);
  });

  it('applies the given stripCommentsFn to the matched files’ source', () => {
    write('pkg/src/hit.ts', 'const x = adminAlertsRepository; // strip me');

    const found = scanMentioningFiles(
      { repoRoot: root, rootNames: ['pkg/src'] },
      'adminalert',
      (s) => s.replace('// strip me', '// STRIPPED')
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.source).toContain('// STRIPPED');
    expect(found[0]?.source).not.toContain('strip me');
  });

  it('excludes test files from the scan, even when they mention the substring', () => {
    write('pkg/src/prod.ts', 'const x = adminAlertsRepository;');
    write('pkg/src/prod.test.ts', 'const x = adminAlertsRepository;');

    const found = scanMentioningFiles(
      { repoRoot: root, rootNames: ['pkg/src'] },
      'adminalert',
      (s) => s
    );

    expect(found.map((f) => f.displayPath)).toEqual(['pkg/src/prod.ts']);
  });
});
