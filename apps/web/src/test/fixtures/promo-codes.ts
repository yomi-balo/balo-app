import type { PromoCode, PromoRedemptionRecord } from '@balo/db';
import type { PromoCodeAdminRow, PromoRedemptionRow } from '@/lib/promo-codes/promo-codes-view';

/**
 * Shared promo-code test fixtures (BAL-384). Centralises the row/record factories that the
 * promo-code unit + component tests all need, so each spec no longer copies the same object
 * literal (keeps new-code duplication under the SonarCloud gate). Lives under
 * `src/test/fixtures/**` — classified as test code by `sonar.test.inclusions` and excluded
 * from coverage by the vitest config. Type-only imports, so nothing runtime is pulled in.
 *
 * Two layers of fixture:
 *  - `makePromo` / `makePromoRecord` — the `@balo/db` shapes the pure derivers + loader read.
 *  - `makePromoRow` / `makePromoRedemptionRow` — the serialisable view-model DTO the client
 *    components render (already-derived: ISO strings, precomputed labels).
 */

/** A `@balo/db` `PromoCode` — the WELCOME50 exemplar (unredeemed, in-window, active). */
export function makePromo(overrides: Partial<PromoCode> = {}): PromoCode {
  return {
    id: 'p-1',
    code: 'WELCOME50',
    grantMinor: 5000,
    perCodeRedemptionCap: 100,
    redeemedCount: 0,
    validFrom: new Date('2026-07-01T00:00:00.000Z'),
    validUntil: new Date('2026-08-01T00:00:00.000Z'),
    status: 'active',
    createdBy: 'admin-1',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

/** A `@balo/db` `PromoRedemptionRecord` — a single human (Dana @ Northwind) redemption. */
export function makePromoRecord(
  overrides: Partial<PromoRedemptionRecord> = {}
): PromoRedemptionRecord {
  return {
    id: 'r-1',
    promoCodeId: 'p-1',
    companyId: 'c-1',
    companyName: 'Northwind Industrial',
    redeemedByUserId: 'u-1',
    redeemedByFirstName: 'Dana',
    redeemedByLastName: 'Whitfield',
    grantedMinor: 5000,
    redeemedAt: new Date('2026-07-10T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * A serialisable `PromoCodeAdminRow` — the WELCOME50 exemplar partially redeemed (30 of 100,
 * 70 left, 30% used). Override `redeemedCount`/`remaining`/`usedPct` for the unredeemed state.
 */
export function makePromoRow(overrides: Partial<PromoCodeAdminRow> = {}): PromoCodeAdminRow {
  return {
    id: 'p-1',
    code: 'WELCOME50',
    grantMinor: 5000,
    grantLabel: 'A$50.00',
    perCodeRedemptionCap: 100,
    redeemedCount: 30,
    remaining: 70,
    usedPct: 30,
    validFromIso: '2026-07-01T00:00:00.000Z',
    validUntilIso: '2026-08-01T00:00:00.000Z',
    displayStatus: 'active',
    redeemable: true,
    redemptions: [],
    ...overrides,
  };
}

/** A serialisable `PromoRedemptionRow` — Dana @ Northwind, A$50.00 granted. */
export function makePromoRedemptionRow(
  overrides: Partial<PromoRedemptionRow> = {}
): PromoRedemptionRow {
  return {
    id: 'r-1',
    companyName: 'Northwind Industrial',
    actorLabel: 'Dana Whitfield',
    grantedMinor: 5000,
    grantedLabel: 'A$50.00',
    redeemedAtIso: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}
