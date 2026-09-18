import { describe, expect, it } from 'vitest';
import { codeLinesOf, occurrences, resolveRouteDir, scanRouteSources } from './_source-scan';

/**
 * BAL-567 / ADR-1029 — structural invariant for **THE `/cases` INDEX NEVER GATES ON A VIEW.**
 * Mirrors `dashboard-up-next-no-view-gate.test.ts`'s shape and intent for this surface.
 *
 * Which LIST renders comes from `navWorkspaceTypeOf(user)` in `_lib/load-cases-index.ts`, which
 * is exactly `activeMode === 'expert' ? 'expert' : 'company'` — a WORKSPACE-SCOPING projection,
 * never an authorization gate (`nav-context.ts`'s own docblock says so). Every copy, layout and
 * affordance decision downstream is a RECORD LOOKUP keyed by `CasesIndexSide`, never a `lens` /
 * `role ===` / `activeMode` comparison. ACCESS is decided by `resolveCompanyParticipation`, and
 * this file also pins that it is called from exactly one place.
 *
 * If this test fails: a view/role comparison crept into a file that should be reading a record
 * instead — fix the code, don't relax the scan.
 */

const CASES_ROUTE_DIR = resolveRouteDir([
  'src/app/(dashboard)/cases',
  'apps/web/src/app/(dashboard)/cases',
]);

/**
 * ⚠⚠ THE WALK IS UNFILTERED OVER THE INDEX'S OWN THREE DIRECTORIES, AND THE PINNED LIST IS
 * ASSERTED AS CONTAINMENT **PLUS AN EXPLICIT COUNT** — never as set equality against a
 * pre-filtered walk (memory `project_bal404_engagement_admin_capability_shipped`: a
 * `PINNED_FILES` set-equality asserted over a FILTERED walk is vacuous, because the filter and
 * the list are then the same statement made twice).
 *
 * `[engagementId]` is excluded because it is the CASE PAGE — BAL-421's code, with its own rules
 * and its own `lens` discriminant, which this ticket does not own and must not assert over.
 */
const EXCLUDED_DIRS = ['[engagementId]'];

function scanCasesIndexSources(): { rel: string; code: string; raw: string }[] {
  return scanRouteSources(CASES_ROUTE_DIR, '', EXCLUDED_DIRS);
}

/** Every file this invariant pins BY NAME, so a rename or deletion fails loudly here. */
const PINNED_FILES: readonly string[] = [
  'page.tsx',
  'loading.tsx',
  'error.tsx',
  '_lib/cases-index-view-types.ts',
  '_lib/cases-index-copy.ts',
  '_lib/cases-index-presentation.ts',
  '_lib/build-cases-index-cards.ts',
  '_lib/load-cases-index.ts',
  '_lib/read-cases-index-data.ts',
  '_actions/cases-index-schema.ts',
  '_actions/load-more-cases.ts',
  '_components/cases-index-shell.tsx',
  '_components/cases-index-click.ts',
  '_components/featured-case-card.tsx',
  '_components/case-card.tsx',
  '_components/case-card-next-slot.tsx',
  '_components/case-counterparty-line.tsx',
  '_components/case-trail.tsx',
  '_components/cases-index-empty-state.tsx',
  '_components/resolved-cases-section.tsx',
];

/**
 * ⚠ `lens` IS ON THIS LIST BUT IS ASSERTED SEPARATELY, BY EXACT OCCURRENCE — see the case below.
 * Every other token is banned outright as a bare substring: the index has no business reading
 * `activeMode`, a platform role or a company role at all.
 */
const VIEW_GATE_TOKENS: readonly string[] = [
  'lens',
  'activeMode',
  'platformRole',
  'companyRole',
  'role ===',
];

describe('invariant: the /cases index never gates on a view (BAL-567)', () => {
  const scanned = scanCasesIndexSources();
  const scannedPaths = scanned.map((file) => file.rel);

  it('collects every pinned file (guards a vacuous pass)', () => {
    expect(CASES_ROUTE_DIR).not.toBe('');
    expect(scanned.length).toBeGreaterThan(0);
    for (const pinned of PINNED_FILES) {
      expect(scannedPaths).toContain(pinned);
    }
    // ⚠ CONTAINMENT PLUS A COUNT. Equality against this walk would be vacuous; the count is what
    // makes a NEW, unpinned file in these directories fail here rather than slip past the scan.
    expect(scannedPaths).toHaveLength(PINNED_FILES.length);
  });

  it('⚠ guards the guard: the matcher sees tokens that ARE genuinely present elsewhere', () => {
    expect(codeLinesOf("if (activeMode === 'expert') { doThing(); }")).toContain('activeMode');
    expect(codeLinesOf('const x = platformRole;')).toContain('platformRole');
    expect(codeLinesOf("if (role === 'admin') {}")).toContain('role ===');
  });

  it('no /cases index file references a VIEW-shaped authorization token', () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      for (const token of VIEW_GATE_TOKENS) {
        // ⚠ `lens` is handled by its own, TIGHTER assertion below — see that case's docblock.
        if (token === 'lens') continue;
        if (file.code.includes(token)) offenders.push(`${file.rel} → ${token}`);
      }
    }
    expect(
      offenders,
      `These /cases index files reference a VIEW-shaped authorization token. The workspace is a ` +
        `record lookup keyed by CasesIndexSide, and access is decided by ` +
        `resolveCompanyParticipation — never by re-deriving activeMode/role/lens here:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  /**
   * ⚠⚠ `lens` IS PINNED BY EXACT OCCURRENCE, NOT EXEMPTED PER FILE (memory
   * `reference_call_tree_lens_ban_is_avoidance_not_allowlist`: an allowlist that says "this file
   * may use it" lets anything through once the file is on the list).
   *
   * The word survives in exactly ONE position on the whole surface: the property name of
   * `selectCaseNudge`'s input, which is the SHARED CORE's parameter and cannot be renamed from
   * here. Its VALUE comes from `CASE_SIDE_BY_WORKSPACE`, a total record — so the assertion is
   * that the word appears once, in that shape, and that it is NEVER COMPARED anywhere. A second
   * use, or any comparison, fails here.
   */
  it('`lens` survives ONLY as selectCaseNudge’s property, and is never compared', () => {
    const totalOccurrences = scanned.reduce(
      (total, file) => total + occurrences(file.code, 'lens'),
      0
    );
    expect(totalOccurrences).toBe(1);

    const builder = scanned.find((file) => file.rel === '_lib/build-cases-index-cards.ts');
    expect(builder?.code ?? '').toContain('lens: caseSide');
    expect(builder?.code ?? '').toContain('CASE_SIDE_BY_WORKSPACE');

    for (const file of scanned) {
      for (const comparison of ['lens ===', 'lens !==', 'lens ?', 'lens =='] as const) {
        expect(file.code).not.toContain(comparison);
      }
    }
  });

  it('resolveCompanyParticipation is called from exactly ONE place, in the loader', () => {
    const loader = scanned.find((file) => file.rel === '_lib/load-cases-index.ts');
    expect(loader).toBeDefined();
    expect(occurrences(loader?.code ?? '', 'resolveCompanyParticipation(')).toBe(1);

    const elsewhere = scanned
      .filter((file) => file.rel !== '_lib/load-cases-index.ts')
      .filter((file) => file.code.includes('resolveCompanyParticipation'))
      .map((file) => file.rel);
    expect(elsewhere).toEqual([]);
  });

  it('no "use client" index file value-imports @balo/db (the next build "tls" footgun)', () => {
    const offenders = scanned
      .filter(
        (file) =>
          (file.raw.includes("'use client'") || file.raw.includes('"use client"')) &&
          file.code.includes("from '@balo/db'")
      )
      .map((file) => file.rel);
    expect(
      offenders,
      `These client components value-import @balo/db, which pulls postgres into the browser ` +
        `graph and breaks \`next build\` with "can't resolve 'tls'":\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('no "use client" index file imports @/lib/logging (bare pino + AsyncLocalStorage)', () => {
    const offenders = scanned
      .filter(
        (file) =>
          (file.raw.includes("'use client'") || file.raw.includes('"use client"')) &&
          file.code.includes("from '@/lib/logging'")
      )
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  /**
   * ⚠ BAL-495's Scan C pins `NAV_ENTRIES` to a single non-test importer, so the page must reach
   * the registry through `resolveEntityListNavEntry` / `resolveNavItems` — never the raw table.
   */
  it('the page resolves its nav label through the registry helper, never NAV_ENTRIES', () => {
    const page = scanned.find((file) => file.rel === 'page.tsx');
    expect(page?.code ?? '').toContain('resolveEntityListNavEntry');
    for (const file of scanned) {
      expect(file.code).not.toContain('NAV_ENTRIES');
    }
  });
});
