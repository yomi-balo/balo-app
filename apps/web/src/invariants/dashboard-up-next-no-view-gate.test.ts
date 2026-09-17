import { describe, expect, it } from 'vitest';
import { codeLinesOf, resolveRouteDir, scanRouteSources } from './_source-scan';

/**
 * BAL-566 / ADR-1029 — structural invariant for **THE DASHBOARD "UP NEXT" CARD NEVER GATES ON A
 * VIEW.** Mirrors `meeting-call-no-lens-gate.test.ts`'s shape and intent for this feature.
 *
 * Workspace comes from `navWorkspaceTypeOf(user)` in `page.tsx`, which is exactly `activeMode
 * === 'expert' ? 'expert' : 'company'` (verified by the orchestrator) — it picks which SLOT
 * renders and nothing else. Every copy/presentation choice downstream of that (footer links,
 * counterparty naming, the ghost-vs-card decision) is a RECORD LOOKUP keyed by
 * `UpNextWorkspaceType`, never a `role ===` / `lens` / `platformRole` comparison. The company
 * read's own access gate is `resolveCompanyParticipation` (D14) — this file also pins that it is
 * called from exactly one place in `load-up-next.ts`.
 *
 * If this test fails: a workspace/role/lens comparison crept into a file that should be reading
 * a record instead — fix the code, don't relax the scan.
 */

const DASHBOARD_LIB_DIR = resolveRouteDir([
  'src/app/(dashboard)/dashboard/_lib',
  'apps/web/src/app/(dashboard)/dashboard/_lib',
]);
const DASHBOARD_COMPONENTS_DIR = resolveRouteDir([
  'src/app/(dashboard)/dashboard/_components',
  'apps/web/src/app/(dashboard)/dashboard/_components',
]);
const DASHBOARD_ROUTE_DIR = resolveRouteDir([
  'src/app/(dashboard)/dashboard',
  'apps/web/src/app/(dashboard)/dashboard',
]);
const HOOKS_DIR = resolveRouteDir(['src/hooks', 'apps/web/src/hooks']);

/**
 * ⚠⚠ AN ALLOW-LIST, NOT THE WHOLE `_lib`/`_components` DIRECTORY. `_components/getting-started-
 * checklist.tsx`, `_components/metric-cards.tsx`, `_components/expert-dashboard.tsx` and friends
 * are pre-existing dashboard surfaces this ticket does not own the rules for — sweeping them in
 * would assert BAL-566's rule over BAL-414/other tickets' code. `page.tsx` is pinned directly
 * (below), not through this filter, because it is the ROUTE file, not a `_lib`/`_components`
 * member. `expert-dashboard.tsx` is ALSO deliberately excluded even though it now renders the
 * `upNext` slot and the R2 banner conditionally — it is BAL-414's file with one added prop and
 * one added conditional render, not a new file this ticket owns whole.
 */
function isUpNextFile(rel: string): boolean {
  return (
    rel.includes('up-next') ||
    rel === '_components/calendar-disconnected-banner.tsx' ||
    rel === '_lib/expert-up-next-surface.ts'
  );
}

function scanDashboardUpNextFiles(): { rel: string; code: string; raw: string }[] {
  return [
    ...scanRouteSources(DASHBOARD_LIB_DIR, '_lib', []).filter((file) => isUpNextFile(file.rel)),
    ...scanRouteSources(DASHBOARD_COMPONENTS_DIR, '_components', []).filter((file) =>
      isUpNextFile(file.rel)
    ),
  ];
}

const PAGE_FILE = resolveRouteDir([
  'src/app/(dashboard)/dashboard/page.tsx',
  'apps/web/src/app/(dashboard)/dashboard/page.tsx',
]);
const VIEWER_CLOCK_FILE = resolveRouteDir([
  'src/hooks/use-viewer-clock.ts',
  'apps/web/src/hooks/use-viewer-clock.ts',
]);

/** The files this invariant pins BY NAME, so a rename or deletion fails loudly here rather than
 *  quietly dropping out of the scan. */
const PINNED_FILES: readonly string[] = [
  '_lib/up-next-view-types.ts',
  '_lib/select-up-next-rows.ts',
  '_lib/build-up-next-rows.ts',
  '_lib/load-up-next.ts',
  '_lib/read-up-next-data.ts',
  '_lib/up-next-presentation.ts',
  '_lib/up-next-copy.ts',
  '_lib/up-next-footer-links.ts',
  '_lib/expert-up-next-surface.ts',
  '_components/up-next-card.tsx',
  '_components/up-next-row.tsx',
  '_components/up-next-card-skeleton.tsx',
  '_components/company-up-next-slot.tsx',
  '_components/expert-up-next-slot.tsx',
  '_components/calendar-disconnected-banner.tsx',
];

const VIEW_GATE_TOKENS: readonly string[] = [
  'lens',
  'activeMode',
  'platformRole',
  'companyRole',
  'role ===',
  "role === '",
];

describe('invariant: the dashboard Up next card never gates on a view (BAL-566)', () => {
  const scanned = scanDashboardUpNextFiles();
  const scannedPaths = scanned.map((file) => file.rel);

  it('collects every pinned file, plus page.tsx and use-viewer-clock.ts (guards a vacuous pass)', () => {
    expect(DASHBOARD_LIB_DIR).not.toBe('');
    expect(DASHBOARD_COMPONENTS_DIR).not.toBe('');
    expect(DASHBOARD_ROUTE_DIR).not.toBe('');
    expect(HOOKS_DIR).not.toBe('');
    expect(PAGE_FILE).not.toBe('');
    expect(VIEWER_CLOCK_FILE).not.toBe('');
    expect(scanned.length).toBeGreaterThan(0);
    for (const pinned of PINNED_FILES) {
      expect(scannedPaths).toContain(pinned);
    }
  });

  it('⚠ guards the guard: the matcher sees tokens that ARE genuinely present elsewhere', () => {
    // `page.tsx` legitimately compares `navWorkspaceTypeOf(user) === 'expert'` — a WORKSPACE
    // comparison, not a view-gate token from the deny-list. Prove the matcher can find a real
    // occurrence of a denied token by constructing one, so a broken `codeLinesOf` cannot pass
    // every assertion below vacuously.
    expect(codeLinesOf("if (activeMode === 'expert') { doThing(); }")).toContain('activeMode');
    expect(codeLinesOf('const x = platformRole;')).toContain('platformRole');
  });

  it('no Up next file references a VIEW-shaped authorization token', () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      for (const token of VIEW_GATE_TOKENS) {
        if (file.code.includes(token)) offenders.push(`${file.rel} → ${token}`);
      }
    }
    expect(
      offenders,
      `These Up next files reference a VIEW-shaped authorization token. Workspace choice is a ` +
        `record lookup keyed by UpNextWorkspaceType, and access is decided by ` +
        `resolveCompanyParticipation — never by re-deriving activeMode/role/lens here:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('page.tsx itself never gates on a view token either (only the workspace-scoping comparison)', () => {
    const page = scanRouteSources(DASHBOARD_ROUTE_DIR, '', ['_lib', '_components']).find(
      (file) => file.rel === 'page.tsx'
    );
    expect(page).toBeDefined();
    // `navWorkspaceTypeOf(user) === 'expert'` is a WORKSPACE-SCOPING comparison, never an
    // authorization gate (nav-context.ts's own docblock states this) — so `activeMode` itself
    // must not appear directly in page.tsx; only the imported function name may.
    expect(page?.code ?? '').not.toContain('activeMode');
    expect(page?.code ?? '').not.toContain('platformRole');
    expect(page?.code ?? '').not.toContain('lens');
  });

  it('use-viewer-clock.ts carries no view-gate token either', () => {
    const hooks = scanRouteSources(HOOKS_DIR, '', []);
    const clock = hooks.find((file) => file.rel === 'use-viewer-clock.ts');
    expect(clock).toBeDefined();
    for (const token of VIEW_GATE_TOKENS) {
      expect(clock?.code ?? '').not.toContain(token);
    }
  });

  it('no "use client" Up next file value-imports @balo/db (the next build "tls" footgun)', () => {
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

  it('no "use client" Up next file imports @/lib/logging (bare pino + AsyncLocalStorage)', () => {
    const offenders = scanned
      .filter(
        (file) =>
          (file.raw.includes("'use client'") || file.raw.includes('"use client"')) &&
          file.code.includes("from '@/lib/logging'")
      )
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('load-up-next.ts calls resolveCompanyParticipation exactly once (D14)', () => {
    const loader = scanned.find((file) => file.rel === '_lib/load-up-next.ts');
    expect(loader).toBeDefined();
    const code = loader?.code ?? '';
    expect([...code.matchAll(/resolveCompanyParticipation\(/g)]).toHaveLength(1);
  });
});
