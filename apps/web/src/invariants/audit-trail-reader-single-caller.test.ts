import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryMemberCallsOf, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-555 — `auditEventsRepository.listTrailForEntity` is a CROSS-TENANT read of any entity's
 * `audit_events` trail, gated by nothing inside `@balo/db` itself:
 * `ListTrailForEntityInput.authorizedPlatformStaff` (`packages/db/src/repositories/
 * audit-events.ts`) is a TYPE-LEVEL obligation only — writing the literal `true` satisfies the
 * compiler regardless of whether the caller actually resolved `VIEW_PLATFORM_ADMIN` first.
 * `admin-lookup-never-writes.test.ts` pins imports only INSIDE `apps/web/.../admin/lookup`, so
 * nothing stops a future module ANYWHERE ELSE in the monorepo from calling this member and
 * passing `true` unauthorized.
 *
 * Modelled on `platform-lookup-repository-single-importer.test.ts` (the SEC-M2 precedent) but
 * keyed on the exact `(object, member)` PAIR via `repositoryMemberCallsOf`, NOT
 * `namedImportsFrom` — `auditEventsRepository` is legitimately IMPORTED by ~30 modules for
 * `record`, so an import-level pin would be hopelessly noisy (and wrong: importing the object
 * is not the unsafe act, calling `listTrailForEntity` on it is).
 *
 * This is a REPO-WIDE scan, not a route-scoped one — deliberately not folded into
 * `admin-lookup-never-writes.test.ts`, which only ever walks one route directory.
 *
 * If this test fails: a new module calls `auditEventsRepository.listTrailForEntity`. Before
 * adding it to `ALLOWED_CALLERS`, verify it resolves `PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN`
 * (or an equivalent already-authorized proof) BEFORE calling — the same pattern
 * `_lib/load-lookup-timeline.ts` uses. Do not add a caller to satisfy this test without doing
 * that check first.
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
 * The ONE authorized caller today — `ListTrailForEntityInput`'s own docblock names it as such.
 * A second entry here is a deliberate, reviewed widening, not a drive-by fix for a failing test.
 */
const ALLOWED_CALLERS: readonly string[] = [
  'apps/web/src/app/(dashboard)/admin/lookup/_lib/load-lookup-timeline.ts',
];

describe('invariant: auditEventsRepository.listTrailForEntity has exactly one caller (BAL-555)', () => {
  it('guards the guard: resolves the repo root and scans a non-trivial number of files', () => {
    expect(REPO_ROOT).not.toBe('');
    expect(SCAN_ROOTS.length).toBeGreaterThan(0);
    // Non-vacuity: a broken walk (wrong root, every directory skipped) would pass every
    // assertion below for the wrong reason.
    expect(SCANNED.length).toBeGreaterThan(100);
    expect(SCANNED.map((file) => file.rel)).toContain(ALLOWED_CALLERS[0]);
  });

  it('guards the guard: the one allowed caller genuinely calls listTrailForEntity', () => {
    const [allowedRel] = ALLOWED_CALLERS;
    const loader = SCANNED.find((file) => file.rel === allowedRel);
    expect(loader).toBeDefined();
    const calls = repositoryMemberCallsOf(loader?.code ?? '');
    expect(calls).toContainEqual({ object: 'auditEventsRepository', member: 'listTrailForEntity' });
  });

  it('no module outside ALLOWED_CALLERS calls auditEventsRepository.listTrailForEntity', () => {
    const offenders: string[] = [];
    for (const file of SCANNED) {
      if (ALLOWED_CALLERS.includes(file.rel)) continue;
      const calls = repositoryMemberCallsOf(file.code);
      if (
        calls.some(
          (call) => call.object === 'auditEventsRepository' && call.member === 'listTrailForEntity'
        )
      ) {
        offenders.push(file.rel);
      }
    }
    expect(
      offenders,
      `These modules call auditEventsRepository.listTrailForEntity outside ALLOWED_CALLERS: ` +
        offenders.join(', ') +
        `. It is a CROSS-TENANT read of any entity's audit trail behind a TYPE-LEVEL-only ` +
        `authorization obligation — verify the new caller resolves VIEW_PLATFORM_ADMIN before ` +
        `calling, then add it here deliberately.`
    ).toEqual([]);
  });
});
