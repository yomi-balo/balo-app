import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { namedImportsFrom, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-551 fix round F8 (SEC-M2, defence in depth) — `platformLookupRepository` finds
 * UNAPPROVED and UNSEARCHABLE experts, wallet balances, and a fee-safe-but-still-cross-tenant
 * view of every party on the platform, gated by nothing inside `@balo/db` itself:
 * `PlatformLookupSearchInput.authorizedPlatformStaff` (`packages/db/src/repositories/
 * platform-lookup.ts`) is a TYPE-LEVEL obligation only — writing the literal `true` satisfies
 * the compiler regardless of whether the caller actually resolved `VIEW_PLATFORM_ADMIN` first.
 * `admin-lookup-never-writes.test.ts` pins imports only INSIDE `apps/web/.../admin/lookup`, so
 * nothing stops a future module ANYWHERE ELSE in the monorepo from importing this repository
 * and passing `true` unauthorized.
 *
 * This is a REPO-WIDE scan, not a route-scoped one — deliberately not folded into
 * `admin-lookup-never-writes.test.ts`, which only ever walks one route directory. It reuses
 * `scanRouteSources` / `namedImportsFrom` from `_source-scan.ts` rather than re-inventing a
 * directory walk and an import scanner (the SAME primitives `admin-lookup-never-writes.test.ts`
 * and `use-server-exports-only-async.test.ts` already use) — `scanRouteSources`'s `dir`
 * parameter is not actually route-scoped, it walks whatever directory it is given.
 *
 * If this test fails: a new module imports `platformLookupRepository`. Before adding it to
 * `ALLOWED_IMPORTERS`, verify it resolves `PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN` (or an
 * equivalent already-authorized proof) BEFORE calling `.search()` — the same pattern
 * `_lib/load-lookup.ts` uses. Do not add an importer to satisfy this test without doing that
 * check first.
 */

const SKIPPED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'coverage',
  '__snapshots__',
];

/**
 * CI runs web vitest from the REPO ROOT while a developer runs it from `apps/web` — the same
 * two-cwd reality `use-server-exports-only-async.test.ts` and `_source-scan.ts`'s
 * `resolveRouteDir` both guard against. This scan additionally needs to walk OUTSIDE
 * `apps/web` (into `apps/api` and `packages/*`), so it resolves the REPO ROOT rather than one
 * app's `src`, verified by the presence of both `apps/web` and `packages/db` — either directory
 * alone could coincidentally exist under the wrong candidate.
 */
const REPO_ROOT =
  ['.', '../..']
    .map((candidate) => path.resolve(process.cwd(), candidate))
    .find(
      (candidate) =>
        existsSync(path.join(candidate, 'apps/web')) &&
        existsSync(path.join(candidate, 'packages/db'))
    ) ?? '';

/** The workspace roots actually walked — every workspace that can reach `@balo/db`. */
const SCAN_ROOTS: readonly string[] = ['apps/web/src', 'apps/api/src', 'packages']
  .map((rel) => path.join(REPO_ROOT, rel))
  .filter((dir) => existsSync(dir));

/**
 * One flat scan across every root, each file's `rel` re-based from ITS OWN root rather than
 * `REPO_ROOT` — `scanRouteSources` computes `rel` relative to whatever `dir` it is given, and
 * this loop passes each `SCAN_ROOTS` entry as that `dir` in turn.
 */
const SCANNED: readonly ScannedFile[] = SCAN_ROOTS.flatMap((root) =>
  scanRouteSources(root, path.relative(REPO_ROOT, root), SKIPPED_DIRECTORIES)
);

/**
 * The ONE authorized caller today — `PlatformLookupSearchInput`'s own docblock names it as
 * such. A second entry here is a deliberate, reviewed widening, not a drive-by fix for a
 * failing test.
 */
const ALLOWED_IMPORTERS: readonly string[] = [
  'apps/web/src/app/(dashboard)/admin/lookup/_lib/load-lookup.ts',
];

describe('invariant: platformLookupRepository has exactly one importer (BAL-551 fix round F8)', () => {
  it('guards the guard: resolves the repo root and scans a non-trivial number of files', () => {
    expect(REPO_ROOT).not.toBe('');
    expect(SCAN_ROOTS.length).toBeGreaterThan(0);
    // Non-vacuity: a broken walk (wrong root, every directory skipped) would pass every
    // assertion below for the wrong reason.
    expect(SCANNED.length).toBeGreaterThan(100);
    expect(SCANNED.map((file) => file.rel)).toContain(ALLOWED_IMPORTERS[0]);
  });

  it('guards the guard: the one allowed importer actually imports platformLookupRepository', () => {
    const [allowedRel] = ALLOWED_IMPORTERS;
    const loader = SCANNED.find((file) => file.rel === allowedRel);
    expect(loader).toBeDefined();
    expect(namedImportsFrom(loader?.code ?? '', '@balo/db')).toContain('platformLookupRepository');
  });

  it('no module outside ALLOWED_IMPORTERS imports platformLookupRepository from @balo/db', () => {
    const offenders: string[] = [];
    for (const file of SCANNED) {
      if (ALLOWED_IMPORTERS.includes(file.rel)) continue;
      if (namedImportsFrom(file.code, '@balo/db').includes('platformLookupRepository')) {
        offenders.push(file.rel);
      }
    }
    expect(
      offenders,
      `These modules import platformLookupRepository outside ALLOWED_IMPORTERS: ` +
        offenders.join(', ') +
        `. It finds unapproved experts, wallet balances and cross-tenant data behind a ` +
        `TYPE-LEVEL-only authorization obligation — verify the new caller resolves ` +
        `VIEW_PLATFORM_ADMIN before calling .search(), then add it here deliberately.`
    ).toEqual([]);
  });
});
