import { describe, expect, it } from 'vitest';
import {
  resolveRouteDir,
  scanRouteSources,
  hasUseServerDirective,
  type ScannedFile,
} from './_source-scan';
import { READ_ONLY_ALLOWLIST } from './_read-only-actions';

/**
 * BAL-548 / ADR-1055 — structural invariant: `admin_alerts` has EXACTLY ONE writer in
 * `apps/web`, and nothing on `READ_ONLY_ALLOWLIST` (the set of Server Actions permitted to
 * authenticate with a bare `requireUser()`) so much as MENTIONS `adminAlertsRepository`.
 *
 * Two properties, both load-bearing:
 *
 *  1. **No allowlisted action writes `admin_alerts`.** `READ_ONLY_ALLOWLIST` is specifically the
 *     set of actions the platform trusts to run pre-onboarding on a bare `requireUser()`
 *     (`_read-only-actions.ts`'s whole docblock). None of them has any business touching the
 *     staff-only pending-actions queue; this derives its subject set FROM that allowlist
 *     (rather than hand-listing files a second time) so a future entry is automatically
 *     covered — the exact "hand-maintained second copy already failed" lesson
 *     `_read-only-actions.ts` records about BAL-424.
 *  2. **`admin_alerts` has exactly one writer.** Across every `'use server'` module in
 *     `apps/web/src`, only `close-admin-alert.ts` may call a WRITE member
 *     (`adminAlertsRepository.close`) — `load-more-admin-alerts.ts` reads
 *     (`.listOpenPage`) and must never grow a write, and no third action may appear.
 *
 * Modelled on `onboarding-mutation-gate.test.ts` (the `READ_ONLY_ALLOWLIST`-derived subject
 * pattern) and `_source-scan.ts` (the shared no-regex scanning primitives).
 *
 * BAL-548 fix round (B-F9) — the "exactly one writer" property used to test ONLY the `.close(`
 * marker, so a stray `adminAlertsRepository.raise(` or `.reconcileKind(` call in some OTHER
 * `apps/web` Server Action would slip past entirely (those two members exist on the
 * repository's own write surface — `apps/api`'s sweep/finder path calls them — `apps/web` must
 * never gain a second call site for either). The write-marker set is now all three.
 */

const SRC_DIR = resolveRouteDir(['src', 'apps/web/src']);

function scanWholeTree(): ScannedFile[] {
  return scanRouteSources(SRC_DIR, '', ['node_modules', '.next']);
}

const CLOSE_ACTION_REL = 'app/(dashboard)/admin/_actions/close-admin-alert.ts';
const LOAD_MORE_ACTION_REL = 'app/(dashboard)/admin/_actions/load-more-admin-alerts.ts';
const CLOSE_WRITE_MARKER = 'adminAlertsRepository.close(';
const RAISE_WRITE_MARKER = 'adminAlertsRepository.raise(';
const RECONCILE_WRITE_MARKER = 'adminAlertsRepository.reconcileKind(';
/** Every member of `adminAlertsRepository` that MUTATES `admin_alerts`. A file "writes" the
 *  table iff its source contains at least one of these. */
const ADMIN_ALERTS_WRITE_MARKERS = [
  CLOSE_WRITE_MARKER,
  RAISE_WRITE_MARKER,
  RECONCILE_WRITE_MARKER,
] as const;

function hasAnyWriteMarker(code: string): boolean {
  return ADMIN_ALERTS_WRITE_MARKERS.some((marker) => code.includes(marker));
}

describe('invariant: admin_alerts has exactly one writer in apps/web (BAL-548 / ADR-1055)', () => {
  const all = scanWholeTree();

  it('scans the full source tree (guards against a vacuous pass)', () => {
    expect(SRC_DIR).not.toBe('');
    expect(all.length).toBeGreaterThan(500);
  });

  it('the read-only allowlist is non-empty and every entry resolves to a scanned file (guards the guard)', () => {
    expect(READ_ONLY_ALLOWLIST.length).toBeGreaterThan(0);
    const relSet = new Set(all.map((file) => file.rel));
    for (const entry of READ_ONLY_ALLOWLIST) {
      expect(relSet.has(entry), `${entry} did not resolve to a scanned file`).toBe(true);
    }
  });

  it('no READ_ONLY_ALLOWLIST action so much as mentions adminAlertsRepository', () => {
    const byRel = new Map(all.map((file) => [file.rel, file]));
    const offenders: string[] = [];
    for (const entry of READ_ONLY_ALLOWLIST) {
      const file = byRel.get(entry);
      if (file !== undefined && file.code.includes('adminAlertsRepository')) {
        offenders.push(entry);
      }
    }
    expect(
      offenders,
      `These READ_ONLY_ALLOWLIST actions (bare requireUser(), pre-onboarding) reference ` +
        `adminAlertsRepository — the staff-only pending-actions queue must never be reachable ` +
        `from a read-only, un-onboarded-safe action:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('detects the close action as a real "use server" module (guards against a dead matcher)', () => {
    const closeFile = all.find((file) => file.rel === CLOSE_ACTION_REL);
    expect(closeFile, `${CLOSE_ACTION_REL} was not found by the scan`).toBeDefined();
    expect(closeFile !== undefined && hasUseServerDirective(closeFile.raw)).toBe(true);
    expect(closeFile?.code.includes(CLOSE_WRITE_MARKER)).toBe(true);
  });

  it('exactly one "use server" module writes admin_alerts, and it is close-admin-alert.ts', () => {
    const serverActions = all.filter((file) => hasUseServerDirective(file.raw));
    const writers = serverActions.filter((file) => hasAnyWriteMarker(file.code));
    expect(writers.map((file) => file.rel)).toEqual([CLOSE_ACTION_REL]);
  });

  it('load-more-admin-alerts.ts reads the queue but never writes it', () => {
    const loadMoreFile = all.find((file) => file.rel === LOAD_MORE_ACTION_REL);
    expect(loadMoreFile, `${LOAD_MORE_ACTION_REL} was not found by the scan`).toBeDefined();
    expect(loadMoreFile?.code).toContain('adminAlertsRepository.listOpenPage(');
    expect(loadMoreFile !== undefined && hasAnyWriteMarker(loadMoreFile.code)).toBe(false);
    expect(loadMoreFile?.code).not.toContain(CLOSE_WRITE_MARKER);
    expect(loadMoreFile?.code).not.toContain(RECONCILE_WRITE_MARKER);
    expect(loadMoreFile?.code).not.toContain(RAISE_WRITE_MARKER);
  });

  it('the close action REFUSES a finder-kind row with a discriminated outcome, never a silent close', () => {
    const closeFile = all.find((file) => file.rel === CLOSE_ACTION_REL);
    expect(closeFile).toBeDefined();
    // The repository's `close()` returns a discriminated `CloseAdminAlertOutcome`; the action
    // must branch on the 'finder_kind' arm explicitly (a refusal, not a bypass) rather than
    // treating every outcome as success.
    expect(closeFile?.code).toContain("case 'finder_kind':");
    expect(closeFile?.code).toContain("reason: 'finder_kind'");
    expect(closeFile?.code).toContain('success: false');
  });

  it('⚠ guards the guard: a decoy write-marker on an allowlisted-shaped path WOULD be caught', () => {
    const decoy: ScannedFile = {
      rel: READ_ONLY_ALLOWLIST[0] ?? '',
      code: 'const x = adminAlertsRepository.close({});',
      raw: '',
    };
    expect(decoy.code.includes('adminAlertsRepository')).toBe(true);
  });

  it(
    '⚠ guards the guard (B-F9): a stray .raise( or .reconcileKind( call site in a SECOND ' +
      '"use server" module would be caught as a second writer, not silently missed',
    () => {
      const decoyRaise: ScannedFile = {
        rel: 'app/(dashboard)/admin/_actions/decoy-raise.ts',
        code: "'use server';\nadminAlertsRepository.raise({});",
        raw: "'use server';\nadminAlertsRepository.raise({});",
      };
      const decoyReconcile: ScannedFile = {
        rel: 'app/(dashboard)/admin/_actions/decoy-reconcile.ts',
        code: "'use server';\nadminAlertsRepository.reconcileKind({});",
        raw: "'use server';\nadminAlertsRepository.reconcileKind({});",
      };
      const withDecoys = [...all, decoyRaise, decoyReconcile];
      const serverActions = withDecoys.filter((file) => hasUseServerDirective(file.raw));
      const writers = serverActions.filter((file) => hasAnyWriteMarker(file.code));
      expect(writers.map((file) => file.rel)).toEqual(
        expect.arrayContaining([CLOSE_ACTION_REL, decoyRaise.rel, decoyReconcile.rel])
      );
      expect(writers).toHaveLength(3);
    }
  );
});
