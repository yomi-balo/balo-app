import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { promoCodes } from '../schema';
import {
  companyFactory,
  promoCodeFactory,
  promoRedemptionFactory,
  userFactory,
} from '../test/factories';
import {
  promoCodesRepository,
  normalizePromoCode,
  DuplicatePromoCodeError,
  PromoCodeNotFoundError,
  CapBelowRedeemedCountError,
  type CreatePromoCodeInput,
} from './promo-codes';

/**
 * Integration tests for the promo-code admin repository (BAL-384). Covers create
 * (happy / uppercase normalization / duplicate), list (newest-first + soft-delete
 * exclusion), getById, deactivate (happy + not-found), updateCap (happy /
 * CapBelowRedeemedCountError / the DB-CHECK backstop), and listAllRedemptions (empty +
 * seeded rows, asserting the company/actor join projection). Factory-seeded; the per-test
 * transaction auto-rolls-back.
 *
 * NOTE: `now()` is transaction-scoped, so all rows seeded in one test tie on their
 * default `created_at` / `redeemed_at`. Ordering assertions therefore seed EXPLICIT
 * distinct timestamps (list) or assert set membership (redemptions).
 */

function baseCreateInput(overrides: Partial<CreatePromoCodeInput> = {}): CreatePromoCodeInput {
  const from = new Date('2026-01-01T00:00:00.000Z');
  const until = new Date('2026-12-31T00:00:00.000Z');
  return {
    code: `WELCOME${Math.floor(Math.random() * 1_000_000)}`,
    grantMinor: 5000,
    perCodeRedemptionCap: 100,
    validFrom: from,
    validUntil: until,
    createdBy: overrides.createdBy ?? '', // filled by the caller via a seeded user
    ...overrides,
  };
}

describe('normalizePromoCode', () => {
  it('trims and uppercases', () => {
    expect(normalizePromoCode('  welcome50  ')).toBe('WELCOME50');
    expect(normalizePromoCode('Summer-Sale')).toBe('SUMMER-SALE');
  });
});

describe('promoCodesRepository.create', () => {
  it('persists a code (happy path) with defaults for status/redeemedCount', async () => {
    const admin = await userFactory();
    const created = await promoCodesRepository.create(
      baseCreateInput({ code: 'HELLO50', createdBy: admin.id })
    );

    expect(created.id).toBeDefined();
    expect(created.code).toBe('HELLO50');
    expect(created.grantMinor).toBe(5000);
    expect(created.perCodeRedemptionCap).toBe(100);
    expect(created.redeemedCount).toBe(0);
    expect(created.status).toBe('active');
    expect(created.createdBy).toBe(admin.id);
    expect(created.deletedAt).toBeNull();
  });

  it('normalizes the code to uppercase (trimmed) on write', async () => {
    const admin = await userFactory();
    const created = await promoCodesRepository.create(
      baseCreateInput({ code: '  welcome50  ', createdBy: admin.id })
    );
    expect(created.code).toBe('WELCOME50');
  });

  it('rejects a duplicate (case-insensitive) with DuplicatePromoCodeError', async () => {
    const admin = await userFactory();
    await promoCodesRepository.create(baseCreateInput({ code: 'welcome50', createdBy: admin.id }));

    await expect(
      promoCodesRepository.create(baseCreateInput({ code: 'WELCOME50', createdBy: admin.id }))
    ).rejects.toBeInstanceOf(DuplicatePromoCodeError);

    // A second raw-cased duplicate collapses to the same normalized value.
    await expect(
      promoCodesRepository.create(baseCreateInput({ code: '  welcome50 ', createdBy: admin.id }))
    ).rejects.toBeInstanceOf(DuplicatePromoCodeError);
  });
});

describe('promoCodesRepository.list', () => {
  it('returns active codes newest-first (by created_at)', async () => {
    const admin = await userFactory();
    const older = await promoCodeFactory({
      createdBy: admin.id,
      values: { code: 'OLDER', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    const middle = await promoCodeFactory({
      createdBy: admin.id,
      values: { code: 'MIDDLE', createdAt: new Date('2026-06-01T00:00:00.000Z') },
    });
    const newest = await promoCodeFactory({
      createdBy: admin.id,
      values: { code: 'NEWEST', createdAt: new Date('2026-12-01T00:00:00.000Z') },
    });

    const rows = await promoCodesRepository.list();
    expect(rows.map((r) => r.id)).toEqual([newest.id, middle.id, older.id]);
  });

  it('excludes soft-deleted codes', async () => {
    const admin = await userFactory();
    const active = await promoCodeFactory({ createdBy: admin.id, values: { code: 'ACTIVEONE' } });
    await promoCodeFactory({
      createdBy: admin.id,
      values: { code: 'DELETEDONE', deletedAt: new Date() },
    });

    const rows = await promoCodesRepository.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(active.id);
  });
});

describe('promoCodesRepository.getById', () => {
  it('returns an active code by id, undefined for missing/soft-deleted', async () => {
    const code = await promoCodeFactory();
    const found = await promoCodesRepository.getById(code.id);
    expect(found?.id).toBe(code.id);

    expect(await promoCodesRepository.getById(randomUUID())).toBeUndefined();

    const deleted = await promoCodeFactory({ values: { code: 'GONE', deletedAt: new Date() } });
    expect(await promoCodesRepository.getById(deleted.id)).toBeUndefined();
  });
});

describe('promoCodesRepository.deactivate', () => {
  it('sets status to deactivated (idempotent), returns the row', async () => {
    const code = await promoCodeFactory();
    expect(code.status).toBe('active');

    const deactivated = await promoCodesRepository.deactivate(code.id);
    expect(deactivated.status).toBe('deactivated');

    // Idempotent — re-deactivating still returns the row.
    const again = await promoCodesRepository.deactivate(code.id);
    expect(again.status).toBe('deactivated');
  });

  it('throws PromoCodeNotFoundError for a missing or soft-deleted code', async () => {
    await expect(promoCodesRepository.deactivate(randomUUID())).rejects.toBeInstanceOf(
      PromoCodeNotFoundError
    );

    const deleted = await promoCodeFactory({ values: { code: 'DELDEACT', deletedAt: new Date() } });
    await expect(promoCodesRepository.deactivate(deleted.id)).rejects.toBeInstanceOf(
      PromoCodeNotFoundError
    );
  });
});

describe('promoCodesRepository.updateCap', () => {
  it('raises the cap (happy path)', async () => {
    const code = await promoCodeFactory({
      values: { code: 'CAPUP', perCodeRedemptionCap: 10, redeemedCount: 2 },
    });
    const updated = await promoCodesRepository.updateCap({ id: code.id, newCap: 25 });
    expect(updated.perCodeRedemptionCap).toBe(25);
  });

  it('allows lowering the cap down to exactly redeemedCount (boundary)', async () => {
    const code = await promoCodeFactory({
      values: { code: 'CAPBOUND', perCodeRedemptionCap: 10, redeemedCount: 4 },
    });
    const updated = await promoCodesRepository.updateCap({ id: code.id, newCap: 4 });
    expect(updated.perCodeRedemptionCap).toBe(4);
  });

  it('throws CapBelowRedeemedCountError when newCap < redeemedCount', async () => {
    const code = await promoCodeFactory({
      values: { code: 'CAPLOW', perCodeRedemptionCap: 100, redeemedCount: 5 },
    });
    await expect(promoCodesRepository.updateCap({ id: code.id, newCap: 3 })).rejects.toBeInstanceOf(
      CapBelowRedeemedCountError
    );

    // The stored cap is unchanged.
    const after = await promoCodesRepository.getById(code.id);
    expect(after?.perCodeRedemptionCap).toBe(100);
  });

  it('throws PromoCodeNotFoundError for a missing code', async () => {
    await expect(
      promoCodesRepository.updateCap({ id: randomUUID(), newCap: 5 })
    ).rejects.toBeInstanceOf(PromoCodeNotFoundError);
  });

  it('DB CHECK backstop: a direct cap-below-count update is rejected by promo_codes_redeemed_within_cap', async () => {
    const code = await promoCodeFactory({
      values: { code: 'CHECKBACK', perCodeRedemptionCap: 100, redeemedCount: 5 },
    });
    // Bypass the repo guard entirely — the DB CHECK must still reject cap < redeemed_count.
    await expect(
      db.update(promoCodes).set({ perCodeRedemptionCap: 3 }).where(eq(promoCodes.id, code.id))
    ).rejects.toThrow();
  });
});

describe('promoCodesRepository.listAllRedemptions', () => {
  it('returns [] when there are no redemptions (empty until BAL-383)', async () => {
    await promoCodeFactory(); // a code with zero redemptions
    expect(await promoCodesRepository.listAllRedemptions()).toEqual([]);
  });

  it('projects company name + actor name for seeded redemptions', async () => {
    const code = await promoCodeFactory({ values: { code: 'REDEEMED', grantMinor: 4200 } });
    const company = await companyFactory({ name: 'Northwind Industrial' });
    const actor = await userFactory({ firstName: 'Dana', lastName: 'Reyes' });

    const seeded = await promoRedemptionFactory({
      promoCodeId: code.id,
      companyId: company.id,
      redeemedByUserId: actor.id,
    });

    const rows = await promoCodesRepository.listAllRedemptions();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.id).toBe(seeded.redemption.id);
    expect(row?.promoCodeId).toBe(code.id);
    expect(row?.companyId).toBe(company.id);
    expect(row?.companyName).toBe('Northwind Industrial');
    expect(row?.redeemedByUserId).toBe(actor.id);
    expect(row?.redeemedByFirstName).toBe('Dana');
    expect(row?.redeemedByLastName).toBe('Reyes');
    expect(row?.grantedMinor).toBe(4200);
    expect(row?.redeemedAt).toBeInstanceOf(Date);
  });

  it('includes a redemption with a null actor (system-promo attribution path)', async () => {
    const code = await promoCodeFactory({ values: { code: 'SYSTEMPROMO' } });
    const company = await companyFactory({ name: 'CloudPeak' });

    await promoRedemptionFactory({
      promoCodeId: code.id,
      companyId: company.id,
      redeemedByUserId: null,
    });

    const rows = await promoCodesRepository.listAllRedemptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.companyName).toBe('CloudPeak');
    expect(rows[0]?.redeemedByUserId).toBeNull();
    expect(rows[0]?.redeemedByFirstName).toBeNull();
    expect(rows[0]?.redeemedByLastName).toBeNull();
  });

  it('returns rows for multiple codes (grouping happens in the view-model, not here)', async () => {
    const codeA = await promoCodeFactory({ values: { code: 'MULTIA' } });
    const codeB = await promoCodeFactory({ values: { code: 'MULTIB' } });
    const r1 = await promoRedemptionFactory({ promoCodeId: codeA.id });
    const r2 = await promoRedemptionFactory({ promoCodeId: codeA.id });
    const r3 = await promoRedemptionFactory({ promoCodeId: codeB.id });

    const rows = await promoCodesRepository.listAllRedemptions();
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(r1.redemption.id)?.promoCodeId).toBe(codeA.id);
    expect(byId.get(r2.redemption.id)?.promoCodeId).toBe(codeA.id);
    expect(byId.get(r3.redemption.id)?.promoCodeId).toBe(codeB.id);
  });
});
