import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasUseServerDirective,
  occurrences,
  resolveRouteDir,
  scanRouteSources,
  type ScannedFile,
} from './_source-scan';
import {
  classifyActionModule,
  classifyActionModules,
  countResolvedSpecifiers,
  createClassificationCache,
  namesLiveCheckedSeam,
  LIVE_CHECKED_SEAMS,
  SEAM_DEFINITION_MODULES,
} from './_action-auth-scan';
import { LIVE_CHECK_EXEMPT_ALLOWLIST, PUBLIC_ACTION_ALLOWLIST } from './_read-only-actions';

/**
 * BAL-568 — structural invariant: **EVERY `'use server'` MODULE IN `apps/web/src` REACHES A
 * LIVE-CHECKED ACTOR-RESOLUTION SEAM — in its own source, one import hop away, or one further
 * re-export hop — OR IS NAMED IN AN ALLOWLIST WITH A WRITTEN REASON.**
 *
 * ⚠⚠ WHY IT IS REPO-WIDE WHERE `onboarding-mutation-gate.test.ts` IS SCOPED TO `app/join/`. That
 * test recorded the obstacle verbatim: a fixed helper-name list cannot see through the
 * per-feature wrappers dozens of correctly-authenticated actions gate through, so a repo-wide
 * name scan would flag them all. `_action-auth-scan.ts` follows imports, which is the stated
 * PREREQUISITE — so the repo-wide property is now implementable, and this file implements it. It
 * is STRICTLY STRONGER than a repo-wide version of BAL-132's "names no auth primitive at all",
 * because anything reaching a live-checked seam a fortiori reads its caller.
 *
 * ⚠ THE WALK IS UNFILTERED; THE ALLOWLIST IS COMPARED, NEVER USED TO FILTER (the BAL-404 lesson:
 * a set-equality assertion against a pre-filtered walk is vacuous). Every non-test `.ts`/`.tsx`
 * under `apps/web/src` is collected first, classified in memory, and only then compared.
 *
 * ⚠ EVERY PREDICATE BELOW IS PAIRED WITH A LENGTH ASSERTION. A vacuous `.every()` / `.filter()`
 * over an empty array passes a suite-level mutation proof; only the paired length assertion
 * notices when the walk has silently gone empty.
 */

const SRC_DIR = resolveRouteDir(['apps/web/src', 'src']);

// SonarCloud S2871 — a bare `.sort()` coerces to string and orders by UTF-16 code unit; these are
// POSIX-style relative paths, so `localeCompare` is a stable, locale-independent comparator.
const REL_COMPARATOR = (a: string, b: string): number => a.localeCompare(b);

const ALLOWLIST_RELS: readonly string[] = LIVE_CHECK_EXEMPT_ALLOWLIST.map((entry) => entry.rel);
const UNION: readonly string[] = [...ALLOWLIST_RELS, ...PUBLIC_ACTION_ALLOWLIST];

const scanned = scanRouteSources(SRC_DIR, '', []);
const classified = classifyActionModules(SRC_DIR, scanned);
const atDepth = (depth: 0 | 1 | 2 | null): typeof classified =>
  classified.filter((entry) => entry.depth === depth);
const unresolved: readonly string[] = atDepth(null).map((entry) => entry.rel);

/** The classification for one module, by path. Fails loudly (not vacuously) when absent. */
function classificationOf(rel: string): (typeof classified)[number] | undefined {
  return classified.find((entry) => entry.rel === rel);
}

/**
 * The shared half of B3 and B4: assert `rel` is genuinely in the scan set and names NO seam in its
 * OWN source — i.e. it is unauthenticated WITHOUT following and authenticated WITH it — then hand
 * back its classification so the caller can pin the depth and the `via` chain.
 *
 * ⚠ THE `namesLiveCheckedSeam(...) === false` CHECK IS THE LOAD-BEARING HALF. Without it, a
 * subject that quietly started naming a seam in its own source would classify at depth 0 and the
 * "following works" proof would pass while proving nothing at all.
 */
function reclassifiedOnly(rel: string): (typeof classified)[number] | undefined {
  const file = scanned.find((candidate) => candidate.rel === rel);
  expect(file, `${rel} must be in the scan set`).toBeDefined();
  expect(
    file === undefined ? true : namesLiveCheckedSeam(file.code),
    `${rel} must name NO seam in its own source — otherwise this proves nothing about following`
  ).toBe(false);
  const result = classificationOf(rel);
  expect(result, `${rel} must be classified`).toBeDefined();
  return result;
}

describe('invariant: every Server Action reaches a live-checked seam, or is allowlisted (BAL-568)', () => {
  it('B1: the walk and the resolver are both non-vacuous', () => {
    expect(SRC_DIR).not.toBe('');
    expect(scanned.length).toBeGreaterThan(1000);
    expect(classified.length).toBeGreaterThanOrEqual(150);
    // Import-following that resolves nothing would classify every wrapper-gated action as
    // unresolved AND would pass B5/B6/B7 only if the allowlist had grown to absorb them. This
    // asserts the resolver actually reaches first-party files on disk.
    expect(countResolvedSpecifiers(SRC_DIR, scanned)).toBeGreaterThanOrEqual(400);
  });

  it('B2: the depth histogram has no empty bucket — following is alive at BOTH levels', () => {
    expect(atDepth(0).length).toBeGreaterThanOrEqual(120);
    expect(atDepth(1).length).toBeGreaterThanOrEqual(20);
    expect(atDepth(2).length).toBeGreaterThanOrEqual(3);
    // The four buckets partition the set — no module is counted twice or lost.
    expect(atDepth(0).length + atDepth(1).length + atDepth(2).length + unresolved.length).toBe(
      classified.length
    );
  });

  /**
   * ⚠⚠ R1's RECLASSIFICATION PROOF, DEPTH 1. Together with B4 these are the ONLY assertions that
   * would notice if import-following silently stopped working — everything else would still pass
   * by growing the allowlist. The `via` chain is pinned VERBATIM for that reason.
   */
  it('B3: ⚠ import-following RECLASSIFIES a real wrapper-gated action (depth 1)', () => {
    const result = reclassifiedOnly(
      'app/(dashboard)/projects/[requestId]/_actions/invite-experts.ts'
    );
    expect(result?.depth).toBe(1);
    expect(result?.via).toEqual([
      'app/(dashboard)/projects/[requestId]/_actions/_shared/require-request-staff-capability.ts',
    ]);
  });

  /**
   * ⚠⚠ R1's RECLASSIFICATION PROOF, DEPTH 2 — the chain that makes one level provably
   * insufficient: `engagement-lifecycle-shared.ts` RE-EXPORTS `requireExpertUser as
   * requireSignedInUser` from `milestone-action-shared.ts`, which is where `requireOnboardedUser`
   * is actually called.
   */
  it('B4: ⚠ import-following RECLASSIFIES a two-hop wrapper chain (depth 2)', () => {
    const result = reclassifiedOnly('app/(dashboard)/engagements/[id]/_actions/accept-project.ts');
    expect(result?.depth).toBe(2);
    expect(result?.via).toEqual([
      'app/(dashboard)/engagements/[id]/_actions/engagement-lifecycle-shared.ts',
      'app/(dashboard)/engagements/[id]/_actions/milestone-action-shared.ts',
    ]);
  });

  it('B5: no UNEXPECTED unresolved module', () => {
    const unexpected = unresolved.filter((rel) => !UNION.includes(rel));
    expect(
      unexpected,
      'A Server Action reaches no live-checked actor seam. Either resolve its actor through ' +
        'requireUser / requireOnboardedUser / withAuth (or call accountRefusalFor explicitly), ' +
        'or add it to LIVE_CHECK_EXEMPT_ALLOWLIST in _read-only-actions.ts WITH A WRITTEN REASON.'
    ).toEqual([]);
    expect(unresolved.length).toBeGreaterThan(0); // the filter above must not be vacuous
  });

  it('B6: no STALE allowlist entry', () => {
    const stale = UNION.filter((rel) => !unresolved.includes(rel));
    expect(
      stale,
      'An allowlisted module now reaches a live-checked seam — remove its entry.'
    ).toEqual([]);
    expect(UNION.length).toBeGreaterThan(0);
  });

  it('B7: exact set equality, both directions, with a size', () => {
    expect([...unresolved].sort(REL_COMPARATOR)).toEqual([...UNION].sort(REL_COMPARATOR));
    // ⚠⚠ 12. THE NUMBER HAS MOVED TWICE, AND NEITHER MOVE WAS A TUNE — each one was a real change
    // to the set, re-measured after the change landed:
    //   · 12 → 11 (fix round 1, F6, 2026-09-18): `app/review/_actions/submit-token-review.ts` was
    //     GATED rather than allowlisted, so it LEFT the unresolved set.
    //   · 11 → 12 (2026-09-19): `app/join/_actions/request-lobby-reentry-link.ts` ARRIVED on main
    //     with BAL-442 — a new, deliberately unauthenticated guest action. **This assertion caught
    //     it**, in CI, on the PR merge commit, which is exactly the BAL-132 property this file
    //     extends: an anonymous Server Action cannot land without a written reason. The reason is
    //     its entry in `PUBLIC_ACTION_ALLOWLIST`; the count follows the entry, never the reverse.
    //
    // ⚠ IF THIS GOES RED, THE ANSWER IS ALMOST NEVER TO CHANGE THE NUMBER. B5 names the new file;
    // gate it, or give it an allowlist entry with a reason that survives being read out loud.
    expect(unresolved).toHaveLength(12);
    expect(UNION).toHaveLength(12);
  });

  it('B8: each allowlist reason is backed by source', () => {
    // ⚠ 9, DOWN FROM 10 — see B7. The entry removed was the one whose stated reason was FALSE.
    expect(LIVE_CHECK_EXEMPT_ALLOWLIST).toHaveLength(9);
    for (const entry of LIVE_CHECK_EXEMPT_ALLOWLIST) {
      const file = scanned.find((candidate) => candidate.rel === entry.rel);
      expect(file, `${entry.rel} must be in the scan set`).toBeDefined();
      expect(
        entry.reason.length,
        `${entry.rel}: the reason must be a real sentence`
      ).toBeGreaterThan(20);
      if (file === undefined) continue;
      expect(
        file.code.includes(entry.proof),
        `${entry.rel}: proof "${entry.proof}" not found in code`
      ).toBe(true);
    }
  });

  it('B9: the two allowlists are disjoint', () => {
    const overlap = ALLOWLIST_RELS.filter((rel) => PUBLIC_ACTION_ALLOWLIST.includes(rel));
    expect(
      overlap,
      'A path appears in BOTH allowlists — one reason must win, or the union double-counts.'
    ).toHaveLength(0);
    expect(ALLOWLIST_RELS.length).toBeGreaterThan(0);
    expect(PUBLIC_ACTION_ALLOWLIST.length).toBeGreaterThan(0);
  });

  it('B10: guards the guard — the classifier reacts to the shapes it claims to detect', () => {
    const cache = createClassificationCache();
    const fixture = (code: string): ScannedFile => ({
      rel: 'app/x/_actions/decoy.ts',
      code,
      raw: `'use server';\n${code}`,
    });
    const depthOf = (code: string): 0 | 1 | 2 | null =>
      classifyActionModule(SRC_DIR, fixture(code), cache).depth;

    // 1. Names no seam, imports nothing first-party → unresolved.
    expect(depthOf("import { z } from 'zod';")).toBeNull();

    // 2. Names a seam in its own source → depth 0.
    expect(depthOf('await requireOnboardedUser();')).toBe(0);

    // 3. Imports a real WRAPPER that itself CALLS a seam (picked from the tree, so the decoy
    //    cannot drift away from reality) → depth 1.
    expect(
      depthOf(
        'import { requireRequestStaffCapability } from ' +
          "'@/app/(dashboard)/projects/[requestId]/_actions/_shared/require-request-staff-capability';"
      )
    ).toBe(1);

    // 3b. Imports a wrapper that only RE-EXPORTS the gate from a sibling → depth 2, through the
    //     re-export arm. ⚠ This is the decoy that would go `null` if depth-2 following broke.
    expect(
      depthOf(
        'import { gateAdminEngagement } from ' +
          "'@/app/(dashboard)/engagements/[id]/_actions/engagement-lifecycle-shared';"
      )
    ).toBe(2);

    // 4. ⚠ Imports a seam DEFINITION module → still UNRESOLVED. Importing FROM the module that
    //    declares the seams proves nothing (`lib/auth/session.ts` also exports `getSession` and
    //    the `SessionUser` type); this exclusion is what keeps the eleven `lib/auth/actions/*`
    //    modules honest.
    expect(depthOf("import { getSession } from '@/lib/auth/session';")).toBeNull();

    // 5. A file that is NOT 'use server' is out of the corpus walk entirely.
    expect(hasUseServerDirective('export function x() {}')).toBe(false);
    expect(hasUseServerDirective("'use server';\nexport async function x() {}")).toBe(true);
  });

  it('B11: SEAM_DEFINITION_MODULES is not stale — each file exists and names what it defines', () => {
    expect(SEAM_DEFINITION_MODULES).toHaveLength(6);
    for (const rel of SEAM_DEFINITION_MODULES) {
      const abs = path.join(SRC_DIR, rel);
      expect(existsSync(abs), `${rel} must exist — a stale entry silently widens the walk`).toBe(
        true
      );
      expect(
        namesLiveCheckedSeam(readFileSync(abs, 'utf8')),
        `${rel} must still name the seam it claims to define`
      ).toBe(true);
    }
  });

  it('B12: LIVE_CHECKED_SEAMS is a clean set, and getSession is NOT on it', () => {
    expect(LIVE_CHECKED_SEAMS.length).toBeGreaterThanOrEqual(8);
    // The substring trap `onboarding-mutation-gate.test.ts` already pins: if one entry contains
    // another, the shorter one makes the longer one unreachable and the list silently lies about
    // what it covers.
    for (const seam of LIVE_CHECKED_SEAMS) {
      const covered = LIVE_CHECKED_SEAMS.filter((other) => other !== seam && seam.includes(other));
      expect(covered, `"${seam}" is covered by ${JSON.stringify(covered)}`).toEqual([]);
    }
    expect(new Set(LIVE_CHECKED_SEAMS).size).toBe(LIVE_CHECKED_SEAMS.length);
    expect(
      LIVE_CHECKED_SEAMS,
      'getSession is the RAW COOKIE READ — it re-reads nothing, and a seven-day-old cookie is ' +
        'exactly what BAL-568 stops trusting. Adding it here would silently reclassify all ' +
        'eleven lib/auth/actions/* modules (sign-in and logout included) as live-checked.'
    ).not.toContain('getSession');
  });

  /**
   * ⚠⚠ THE EDGE-BUNDLE PIN. `session.ts` now transitively pulls `@balo/db` (via
   * `./account-liveness` → `./live-user`), so a VALUE import from `middleware.ts` would drag
   * Drizzle + `postgres` into the Edge bundle and break the build — a failure that shows up only
   * at `next build`, never in a unit test (memory `reference_balo_db_client_bundle_footgun`).
   */
  it('B13: ⚠ middleware.ts imports SessionData TYPE-ONLY', () => {
    const abs = path.join(SRC_DIR, 'middleware.ts');
    expect(existsSync(abs)).toBe(true);
    const code = readFileSync(abs, 'utf8');
    expect(code.length).toBeGreaterThan(100);
    const TYPE_IMPORT = "import type { SessionData } from '@/lib/auth/session'";
    const ANY_REFERENCE = "from '@/lib/auth/session'";
    expect(
      occurrences(code, TYPE_IMPORT),
      'middleware.ts must import SessionData with `import type` — verbatim'
    ).toBe(1);
    // ⚠ EXACT COUNT EQUALITY, not merely "the type import is present": the type-only import is
    // the ONLY reference to that specifier, so a second (value) import cannot hide beside it.
    expect(
      occurrences(code, ANY_REFERENCE),
      'middleware.ts must not value-import anything from @/lib/auth/session — it would pull ' +
        'Drizzle + postgres into the Edge bundle.'
    ).toBe(occurrences(code, TYPE_IMPORT));
  });
});
