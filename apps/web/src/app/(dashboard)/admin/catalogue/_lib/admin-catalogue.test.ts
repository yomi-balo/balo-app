import { describe, it, expect } from 'vitest';
import { PLATFORM_CAPABILITIES, type PlatformCapability } from '@balo/shared/authz';
import { ADMIN_CATALOGUE_ROWS, resolveCatalogueRows } from './admin-catalogue';

const FULL_STAFF_SET: readonly PlatformCapability[] = Object.values(PLATFORM_CAPABILITIES);

describe('ADMIN_CATALOGUE_ROWS (D9)', () => {
  it('is the seven pinned rows, in order, with the design reference’s statuses and tones', () => {
    // BAL-551 fix round F14 — the catalogue indexes "the admin surfaces that already exist",
    // and Lookup now exists.
    expect(ADMIN_CATALOGUE_ROWS.map((r) => [r.title, r.href, r.status, r.tone])).toEqual([
      ['Projects', '/projects?lens=admin', 'Shipped', 'success'],
      ['Platform config', '/admin/config', 'Not on main yet', 'warning'],
      ['Promo codes', '/promo-codes', 'Shipped', 'success'],
      ['Engagements', '/engagements', 'Shipped', 'success'],
      ['Lookup', '/admin/lookup', 'Shipped', 'success'],
      ['Featured experts', '/admin/config/spotlight', 'Designed — BAL-493', 'neutral'],
      ['Taxonomy', '/admin/taxonomy', 'Seeded, not editable', 'neutral'],
    ]);
  });

  it('every requiredCapability is a REAL token (no fictional MANAGE_PLATFORM_CONFIG)', () => {
    for (const row of ADMIN_CATALOGUE_ROWS) {
      if (row.requiredCapability !== null) {
        expect(FULL_STAFF_SET).toContain(row.requiredCapability);
      }
    }
  });

  it('keys are unique', () => {
    expect(new Set(ADMIN_CATALOGUE_ROWS.map((r) => r.key)).size).toBe(ADMIN_CATALOGUE_ROWS.length);
  });
});

describe('resolveCatalogueRows (D10)', () => {
  it('a full staff bundle sees NO view-only row — the production state today', () => {
    const resolved = resolveCatalogueRows(ADMIN_CATALOGUE_ROWS, FULL_STAFF_SET);
    expect(resolved.every((r) => !r.isViewOnly)).toBe(true);
  });

  it('SYNTHETIC HELD SET omitting MANAGE_PROMO_CODES makes exactly the Promo codes row view-only', () => {
    // ⚠ The D5 bundle split is what makes this reachable in production. Until then this
    // synthetic set is the ONLY way the branch is exercised — which is precisely why it is here
    // rather than left as an untested "gated" flag.
    const withoutPromo = FULL_STAFF_SET.filter(
      (c) => c !== PLATFORM_CAPABILITIES.MANAGE_PROMO_CODES
    );
    const resolved = resolveCatalogueRows(ADMIN_CATALOGUE_ROWS, withoutPromo);
    expect(resolved.filter((r) => r.isViewOnly).map((r) => r.key)).toEqual(['promo_codes']);
  });

  it('an empty held set gates every row that HAS a capability, and no others', () => {
    const resolved = resolveCatalogueRows(ADMIN_CATALOGUE_ROWS, []);
    // ⚠ BAL-404 ADDED 'engagements' HERE. Its row went from `requiredCapability: null` (gated by
    // nothing — a leftover from when the page itself gated on the `isPlatformAdmin` role set) to
    // `VIEW_PLATFORM_ADMIN` (C3), so it now joins every other capability-gated row in this set.
    // ⚠ STRUCTURALLY INERT, same as the pre-existing 'lookup' row: `admin/layout.tsx:47` already
    // requires `VIEW_PLATFORM_ADMIN` to reach the catalogue page at all, so no viewer who can see
    // this row can ever lack the capability its own row asks for — `isViewOnly` can never be
    // `true` for 'engagements' in production. This synthetic empty-held-set input is the only way
    // the branch is exercised at all (mirrors the SYNTHETIC HELD SET test above).
    expect(resolved.filter((r) => r.isViewOnly).map((r) => r.key)).toEqual([
      'promo_codes',
      'engagements',
      'lookup',
    ]);
    expect(resolved.filter((r) => r.requiredCapability === null).every((r) => !r.isViewOnly)).toBe(
      true
    );
  });

  it('linkHref is the href for shipped rows and null for the rest — no dead links (D9)', () => {
    const resolved = resolveCatalogueRows(ADMIN_CATALOGUE_ROWS, FULL_STAFF_SET);
    expect(resolved.filter((r) => r.linkHref !== null).map((r) => r.key)).toEqual([
      'projects',
      'promo_codes',
      'engagements',
      'lookup',
    ]);
    expect(resolved.filter((r) => r.linkHref === null).map((r) => r.key)).toEqual([
      'platform_config',
      'featured_experts',
      'taxonomy',
    ]);
  });

  it('gating and linking are independent: a gated SHIPPED row still links', () => {
    const [promo] = resolveCatalogueRows(
      ADMIN_CATALOGUE_ROWS.filter((r) => r.key === 'promo_codes'),
      []
    );
    expect(promo?.isViewOnly).toBe(true);
    expect(promo?.linkHref).toBe('/promo-codes');
  });
});
