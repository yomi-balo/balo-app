import { describe, expect, it } from 'vitest';
import { resolveRouteDir, scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-622 — structural invariant: **THE STAFF MONEY VIEW HAS ONE IMPORTER.**
 *
 * `lib/engagement/change-order-admin-view.ts` serialises BOTH sides of every change-order
 * amount (expert, client, Balo margin, final invoice). The client and expert view models must
 * never reach it: fee concealment holds because only the engagement page imports it, and only
 * behind the `VIEW_PLATFORM_ADMIN` platform capability. A second importer would be a second
 * place that has to remember the gate.
 *
 * The walk is unfiltered (every non-test source under `apps/web/src`) and the importer set is
 * compared for exact equality, never used to filter. A positive control proves the matcher sees
 * a genuine importer, so a broken scan cannot pass vacuously.
 */

const SRC_DIR = resolveRouteDir(['apps/web/src', 'src']);

const ADMIN_VIEW_MODULE = 'lib/engagement/change-order-admin-view.ts';
const SPECIFIERS: readonly string[] = [
  "/change-order-admin-view'",
  '/change-order-admin-view"',
  "./change-order-admin-view'",
];

/** The only module allowed to import the staff money view. */
const ALLOWED_IMPORTERS: readonly string[] = ['app/(dashboard)/engagements/[id]/page.tsx'];

describe('invariant: the change-order admin money view has a single importer (BAL-622)', () => {
  const scanned: ScannedFile[] = scanRouteSources(SRC_DIR, '', []);
  const importers = scanned
    .filter((file) => file.rel !== ADMIN_VIEW_MODULE)
    .filter((file) => SPECIFIERS.some((specifier) => file.code.includes(specifier)))
    .map((file) => file.rel)
    .sort((a, b) => a.localeCompare(b));

  it('scans the tree and finds the admin view module (non-vacuity)', () => {
    expect(SRC_DIR).not.toBe('');
    expect(scanned.some((file) => file.rel === ADMIN_VIEW_MODULE)).toBe(true);
  });

  it('is imported only by the engagement page', () => {
    expect(importers).toEqual(ALLOWED_IMPORTERS);
  });

  it('positive control: the matcher recognises a genuine importer', () => {
    const page = scanned.find((file) => file.rel === ALLOWED_IMPORTERS[0]);
    expect(page, `${ALLOWED_IMPORTERS[0]} must exist`).toBeDefined();
    expect(SPECIFIERS.some((specifier) => page?.code.includes(specifier))).toBe(true);
  });

  it('the page reads it behind the VIEW_PLATFORM_ADMIN platform capability', () => {
    const page = scanned.find((file) => file.rel === ALLOWED_IMPORTERS[0]);
    expect(page?.code).toContain(
      'hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)'
    );
  });
});
