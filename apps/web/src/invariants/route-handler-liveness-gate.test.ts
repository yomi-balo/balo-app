import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';
import {
  classifyActionModule,
  createClassificationCache,
  namesLiveCheckedSeam,
} from './_action-auth-scan';
import { ROUTE_HANDLER_EXEMPT_ALLOWLIST } from './_read-only-actions';

/**
 * BAL-568 fix round 1 (F1) — structural invariant: **EVERY ROUTE HANDLER IN `apps/web` REACHES A
 * LIVE-CHECKED ACTOR-RESOLUTION SEAM, OR IS NAMED HERE WITH A WRITTEN REASON.**
 *
 * ⚠⚠ THIS FILE EXISTS BECAUSE AN UNGATED ROUTE HANDLER SHIPPED AND NO INVARIANT COULD SEE IT.
 * `account-liveness-gate.test.ts` walks `'use server'` modules; a Route Handler is not one, so all
 * thirteen of them were outside its corpus. `app/api/auth/switch-workspace/route.ts` resolved its
 * actor with a bare `getSession()` and then, through `switchWorkspace`, WROTE to `users` and called
 * `session.save()` — **re-sealing a fresh seven-day cookie for a suspended account**. It was found
 * by the security gate, not by the invariant, which is the whole argument for this file: a corpus
 * that omits a whole class of entry point is a corpus that will omit the next defect too.
 *
 * ⚠ IT REUSES `classifyActionModule` VERBATIM — the same depth-0/1/2 rules, the same seam list, the
 * same definition-module exclusion. A second, parallel classifier would be a second definition of
 * "is this gated", and the two would drift.
 *
 * ⚠ THE WALK IS UNFILTERED; THE ALLOWLIST IS COMPARED, NEVER USED TO FILTER (the BAL-404 lesson).
 */

const SRC_DIR = resolveRouteDir(['apps/web/src', 'src']);

const REL_COMPARATOR = (a: string, b: string): number => a.localeCompare(b);

/** A Route Handler: a file named exactly `route.ts` / `route.tsx` under `app/`. */
function isRouteHandler(file: ScannedFile): boolean {
  if (!file.rel.startsWith('app/')) return false;
  const base = file.rel.slice(file.rel.lastIndexOf('/') + 1);
  return base === 'route.ts' || base === 'route.tsx';
}

const ALLOWLIST_RELS: readonly string[] = ROUTE_HANDLER_EXEMPT_ALLOWLIST.map((e) => e.rel);

const scanned = scanRouteSources(SRC_DIR, '', []);
const routes = scanned.filter(isRouteHandler);
const cache = createClassificationCache();
const classified = routes.map((file) => classifyActionModule(SRC_DIR, file, cache));
const unresolved: readonly string[] = classified
  .filter((entry) => entry.depth === null)
  .map((entry) => entry.rel);

describe('invariant: every Route Handler is liveness-gated, or allowlisted (BAL-568 / F1)', () => {
  it('R1: the walk finds the Route Handlers (non-vacuity)', () => {
    expect(SRC_DIR).not.toBe('');
    expect(scanned.length).toBeGreaterThan(1000);
    // Thirteen today. A floor, not an equality: a new handler must be CLASSIFIED, not counted.
    expect(routes.length).toBeGreaterThanOrEqual(10);
    expect(classified).toHaveLength(routes.length);
  });

  it('R2: the gated handlers are genuinely gated, and following is alive here too', () => {
    const gated = classified.filter((entry) => entry.depth !== null);
    expect(gated.length).toBeGreaterThanOrEqual(6);
    // At least one resolves through an import hop — the same mechanism the action walk relies on.
    expect(gated.some((entry) => entry.depth === 1)).toBe(true);
  });

  /**
   * ⚠⚠ THE REGRESSION PIN. This is the handler the security gate caught: it writes to `users` and
   * re-seals a seven-day cookie, so an ungated version is a suspended account both acting AND
   * having its session renewed. Pinned at depth 0 — it gates in its OWN source.
   */
  it('R3: ⚠ switch-workspace is gated IN ITS OWN SOURCE (the F1 regression)', () => {
    const REL = 'app/api/auth/switch-workspace/route.ts';
    const file = routes.find((candidate) => candidate.rel === REL);
    expect(file, `${REL} must be in the scan set`).toBeDefined();
    if (file === undefined) return;

    expect(namesLiveCheckedSeam(file.code), `${REL} must name a live-checked seam`).toBe(true);
    expect(classified.find((entry) => entry.rel === REL)?.depth).toBe(0);
    // And it must refuse through the SYNC ROUTE, not a bare /login — that is what preserves
    // BAL-197's account_suspended / account_deleted copy.
    expect(file.code).toContain('/api/auth/session-sync?returnTo=/login');
  });

  it('R4: no UNEXPECTED ungated Route Handler', () => {
    const unexpected = unresolved.filter((rel) => !ALLOWLIST_RELS.includes(rel));
    expect(
      unexpected,
      'A Route Handler resolves its actor without a liveness gate. Route Handlers are NOT covered ' +
        'by the Server Action invariant. Either resolve the actor through getCurrentUser / ' +
        'requireUser, or call accountRefusalFor explicitly, or add it to ' +
        'ROUTE_HANDLER_EXEMPT_ALLOWLIST in _read-only-actions.ts WITH A WRITTEN REASON.'
    ).toEqual([]);
    expect(unresolved.length).toBeGreaterThan(0); // the filter must not be vacuous
  });

  it('R5: no STALE allowlist entry', () => {
    const stale = ALLOWLIST_RELS.filter((rel) => !unresolved.includes(rel));
    expect(stale, 'An allowlisted Route Handler is now gated — remove its entry.').toEqual([]);
    expect(ALLOWLIST_RELS.length).toBeGreaterThan(0);
  });

  it('R6: exact set equality, both directions, with a size', () => {
    expect([...unresolved].sort(REL_COMPARATOR)).toEqual([...ALLOWLIST_RELS].sort(REL_COMPARATOR));
    expect(unresolved).toHaveLength(5);
  });

  it('R7: each allowlist reason is backed by source', () => {
    expect(ROUTE_HANDLER_EXEMPT_ALLOWLIST).toHaveLength(5);
    for (const entry of ROUTE_HANDLER_EXEMPT_ALLOWLIST) {
      const file = routes.find((candidate) => candidate.rel === entry.rel);
      expect(file, `${entry.rel} must be in the Route Handler scan set`).toBeDefined();
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

  it('R8: guards the guard — the Route Handler filter matches what it claims', () => {
    const fixture = (rel: string): ScannedFile => ({ rel, code: '', raw: '' });
    expect(isRouteHandler(fixture('app/api/x/route.ts'))).toBe(true);
    expect(isRouteHandler(fixture('app/(dashboard)/x/y/route.tsx'))).toBe(true);
    // Not a handler: a page, a lib module, a file merely CONTAINING the word `route`.
    expect(isRouteHandler(fixture('app/api/x/page.tsx'))).toBe(false);
    expect(isRouteHandler(fixture('lib/api/route.ts'))).toBe(false);
    expect(isRouteHandler(fixture('app/api/x/my-route.ts'))).toBe(false);
    expect(isRouteHandler(fixture('app/api/x/route-config.ts'))).toBe(false);
  });
});
