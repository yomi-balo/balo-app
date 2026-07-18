import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { promoCodes, promoRedemptions } from '../schema';
import {
  companyFactory,
  promoCodeFactory,
  promoRedemptionFactory,
  userFactory,
} from '../test/factories';
import { creditWalletsRepository } from './credit-wallets';
import { creditLedgerRepository } from './credit-ledger';
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

/**
 * BAL-383 redeem write-path. Deterministic windows + an injected `now` so validity is
 * exact regardless of the wall clock. Each test runs in the auto-rolled-back per-test
 * transaction; `redeem`'s own `db.transaction` nests as a SAVEPOINT.
 */
const WINDOW_FROM = new Date('2026-01-01T00:00:00.000Z');
const WINDOW_UNTIL = new Date('2026-12-31T00:00:00.000Z');
const WITHIN_WINDOW = new Date('2026-06-01T00:00:00.000Z');

/** All redemption rows for a code (direct read — not the admin projection). */
async function redemptionRowsFor(promoCodeId: string) {
  return db.select().from(promoRedemptions).where(eq(promoRedemptions.promoCodeId, promoCodeId));
}

describe('promoCodesRepository.redeem — happy path', () => {
  it('grants credit, inserts a redemption, bumps redeemed_count, and auto-creates the wallet', async () => {
    const promo = await promoCodeFactory({
      values: {
        code: 'WELCOME50',
        grantMinor: 5000,
        perCodeRedemptionCap: 100,
        redeemedCount: 0,
        validFrom: WINDOW_FROM,
        validUntil: WINDOW_UNTIL,
      },
    });
    const company = await companyFactory();
    const actor = await userFactory();

    // First-ever credit event: no wallet exists yet.
    expect(await creditWalletsRepository.findByCompanyId(company.id)).toBeUndefined();

    const result = await promoCodesRepository.redeem({
      rawCode: 'WELCOME50',
      companyId: company.id,
      redeemedByUserId: actor.id,
      now: WITHIN_WINDOW,
    });

    expect(result.outcome).toBe('redeemed');
    if (result.outcome !== 'redeemed') throw new Error(`expected redeemed, got ${result.outcome}`);
    expect(result.grantedMinor).toBe(5000);
    expect(result.balanceAfterMinor).toBe(5000);
    expect(result.redeemedCount).toBe(1);
    expect(result.perCodeRedemptionCap).toBe(100);
    expect(result.redemption.companyId).toBe(company.id);
    expect(result.redemption.redeemedByUserId).toBe(actor.id);
    expect(result.redemption.grantedMinor).toBe(5000);

    // Wallet auto-created and credited by the grant.
    const wallet = await creditWalletsRepository.findByCompanyId(company.id);
    expect(wallet).toBeDefined();
    if (wallet === undefined) throw new Error('wallet was not created');
    expect(wallet.balanceMinor).toBe(5000);

    // redeemed_count persisted.
    const afterPromo = await promoCodesRepository.getById(promo.id);
    expect(afterPromo?.redeemedCount).toBe(1);

    // Exactly one ledger entry — a `promo` / `adjustment` system grant, no attributed member.
    const ledger = await creditLedgerRepository.listByWallet(wallet.id);
    expect(ledger).toHaveLength(1);
    const [entry] = ledger;
    expect(entry?.reason).toBe('promo');
    expect(entry?.entryType).toBe('adjustment');
    expect(entry?.amountMinor).toBe(5000);
    expect(entry?.memberId).toBeNull();
    expect(entry?.id).toBe(result.redemption.ledgerEntryId);

    // One redemption row for the code.
    expect(await redemptionRowsFor(promo.id)).toHaveLength(1);
  });
});

describe('promoCodesRepository.redeem — idempotency & single-use', () => {
  it('idempotent retry: a second redeem for the same (company, code) is already_redeemed with no new writes', async () => {
    const promo = await promoCodeFactory({
      values: {
        code: 'RETRY50',
        grantMinor: 5000,
        perCodeRedemptionCap: 100,
        validFrom: WINDOW_FROM,
        validUntil: WINDOW_UNTIL,
      },
    });
    const company = await companyFactory();
    const actor = await userFactory();

    const first = await promoCodesRepository.redeem({
      rawCode: 'RETRY50',
      companyId: company.id,
      redeemedByUserId: actor.id,
      now: WITHIN_WINDOW,
    });
    expect(first.outcome).toBe('redeemed');

    const second = await promoCodesRepository.redeem({
      rawCode: 'RETRY50',
      companyId: company.id,
      redeemedByUserId: actor.id,
      now: WITHIN_WINDOW,
    });
    expect(second.outcome).toBe('already_redeemed');
    if (second.outcome !== 'already_redeemed') throw new Error('expected already_redeemed');
    expect(second.grantedMinor).toBe(5000);

    // No double-count.
    const afterPromo = await promoCodesRepository.getById(promo.id);
    expect(afterPromo?.redeemedCount).toBe(1);

    // Exactly ONE ledger entry and ONE redemption row; balance credited once.
    const wallet = await creditWalletsRepository.findByCompanyId(company.id);
    expect(wallet).toBeDefined();
    if (wallet === undefined) throw new Error('wallet missing');
    expect(wallet.balanceMinor).toBe(5000);
    expect(await creditLedgerRepository.listByWallet(wallet.id)).toHaveLength(1);
    expect(await redemptionRowsFor(promo.id)).toHaveLength(1);
  });

  it('single-use per company: a second, distinct member redeeming the same code is already_redeemed', async () => {
    const promo = await promoCodeFactory({
      values: {
        code: 'ONEPER',
        grantMinor: 5000,
        perCodeRedemptionCap: 100,
        validFrom: WINDOW_FROM,
        validUntil: WINDOW_UNTIL,
      },
    });
    const company = await companyFactory();
    const memberA = await userFactory();
    const memberB = await userFactory();

    const first = await promoCodesRepository.redeem({
      rawCode: 'ONEPER',
      companyId: company.id,
      redeemedByUserId: memberA.id,
      now: WITHIN_WINDOW,
    });
    expect(first.outcome).toBe('redeemed');

    // A different individual, same PARTY — dedup is by (promoCodeId, companyId).
    const second = await promoCodesRepository.redeem({
      rawCode: 'ONEPER',
      companyId: company.id,
      redeemedByUserId: memberB.id,
      now: WITHIN_WINDOW,
    });
    expect(second.outcome).toBe('already_redeemed');

    const afterPromo = await promoCodesRepository.getById(promo.id);
    expect(afterPromo?.redeemedCount).toBe(1);
    expect(await redemptionRowsFor(promo.id)).toHaveLength(1);
  });

  it('different companies redeeming the same code each succeed (redeemed_count == 2)', async () => {
    const promo = await promoCodeFactory({
      values: {
        code: 'TWOCO',
        grantMinor: 5000,
        perCodeRedemptionCap: 100,
        validFrom: WINDOW_FROM,
        validUntil: WINDOW_UNTIL,
      },
    });
    const companyA = await companyFactory();
    const companyB = await companyFactory();
    const actorA = await userFactory();
    const actorB = await userFactory();

    const a = await promoCodesRepository.redeem({
      rawCode: 'TWOCO',
      companyId: companyA.id,
      redeemedByUserId: actorA.id,
      now: WITHIN_WINDOW,
    });
    const b = await promoCodesRepository.redeem({
      rawCode: 'TWOCO',
      companyId: companyB.id,
      redeemedByUserId: actorB.id,
      now: WITHIN_WINDOW,
    });

    expect(a.outcome).toBe('redeemed');
    expect(b.outcome).toBe('redeemed');

    const afterPromo = await promoCodesRepository.getById(promo.id);
    expect(afterPromo?.redeemedCount).toBe(2);
    expect(await redemptionRowsFor(promo.id)).toHaveLength(2);

    // Each company got its own wallet + grant.
    const walletA = await creditWalletsRepository.findByCompanyId(companyA.id);
    const walletB = await creditWalletsRepository.findByCompanyId(companyB.id);
    expect(walletA?.balanceMinor).toBe(5000);
    expect(walletB?.balanceMinor).toBe(5000);
    expect(walletA?.id).not.toBe(walletB?.id);
  });
});

describe('promoCodesRepository.redeem — warm refusals (no writes)', () => {
  it('expired: now >= valid_until', async () => {
    const promo = await promoCodeFactory({
      values: {
        code: 'EXPIRED',
        validFrom: WINDOW_FROM,
        validUntil: new Date('2026-06-01T00:00:00.000Z'),
      },
    });
    const company = await companyFactory();
    const actor = await userFactory();

    const result = await promoCodesRepository.redeem({
      rawCode: 'EXPIRED',
      companyId: company.id,
      redeemedByUserId: actor.id,
      now: new Date('2026-07-01T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('expired');
    if (result.outcome !== 'expired') throw new Error('expected expired');
    expect(result.validUntil.toISOString()).toBe('2026-06-01T00:00:00.000Z');

    // No side effects.
    expect((await promoCodesRepository.getById(promo.id))?.redeemedCount).toBe(0);
    expect(await creditWalletsRepository.findByCompanyId(company.id)).toBeUndefined();
    expect(await redemptionRowsFor(promo.id)).toHaveLength(0);
  });

  it('scheduled: now < valid_from', async () => {
    const promo = await promoCodeFactory({
      values: {
        code: 'SCHEDULED',
        validFrom: new Date('2026-06-01T00:00:00.000Z'),
        validUntil: WINDOW_UNTIL,
      },
    });
    const company = await companyFactory();
    const actor = await userFactory();

    const result = await promoCodesRepository.redeem({
      rawCode: 'SCHEDULED',
      companyId: company.id,
      redeemedByUserId: actor.id,
      now: new Date('2026-01-15T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('scheduled');
    if (result.outcome !== 'scheduled') throw new Error('expected scheduled');
    expect(result.validFrom.toISOString()).toBe('2026-06-01T00:00:00.000Z');

    expect((await promoCodesRepository.getById(promo.id))?.redeemedCount).toBe(0);
    expect(await redemptionRowsFor(promo.id)).toHaveLength(0);
  });

  it('deactivated: status is deactivated (precedence over the validity window)', async () => {
    const promo = await promoCodeFactory({
      values: {
        code: 'DEACT',
        status: 'deactivated',
        validFrom: WINDOW_FROM,
        validUntil: WINDOW_UNTIL,
      },
    });
    const company = await companyFactory();
    const actor = await userFactory();

    const result = await promoCodesRepository.redeem({
      rawCode: 'DEACT',
      companyId: company.id,
      redeemedByUserId: actor.id,
      now: WITHIN_WINDOW,
    });

    expect(result.outcome).toBe('deactivated');
    expect((await promoCodesRepository.getById(promo.id))?.redeemedCount).toBe(0);
    expect(await redemptionRowsFor(promo.id)).toHaveLength(0);
  });

  it('exhausted: redeemed_count already at the cap', async () => {
    const promo = await promoCodeFactory({
      values: {
        code: 'FULL',
        perCodeRedemptionCap: 1,
        redeemedCount: 1,
        validFrom: WINDOW_FROM,
        validUntil: WINDOW_UNTIL,
      },
    });
    const company = await companyFactory();
    const actor = await userFactory();

    const result = await promoCodesRepository.redeem({
      rawCode: 'FULL',
      companyId: company.id,
      redeemedByUserId: actor.id,
      now: WITHIN_WINDOW,
    });

    expect(result.outcome).toBe('exhausted');
    // Count unchanged; no wallet or redemption created.
    expect((await promoCodesRepository.getById(promo.id))?.redeemedCount).toBe(1);
    expect(await creditWalletsRepository.findByCompanyId(company.id)).toBeUndefined();
    expect(await redemptionRowsFor(promo.id)).toHaveLength(0);
  });

  it('not_found: an unknown code', async () => {
    const company = await companyFactory();
    const actor = await userFactory();

    const result = await promoCodesRepository.redeem({
      rawCode: 'NOSUCHCODE',
      companyId: company.id,
      redeemedByUserId: actor.id,
      now: WITHIN_WINDOW,
    });
    expect(result.outcome).toBe('not_found');
  });

  it('not_found: a soft-deleted code (the FOR UPDATE lookup filters deleted_at IS NULL)', async () => {
    const promo = await promoCodeFactory({
      values: {
        code: 'GONE50',
        validFrom: WINDOW_FROM,
        validUntil: WINDOW_UNTIL,
        deletedAt: new Date('2026-02-01T00:00:00.000Z'),
      },
    });
    const company = await companyFactory();
    const actor = await userFactory();

    const result = await promoCodesRepository.redeem({
      rawCode: 'GONE50',
      companyId: company.id,
      redeemedByUserId: actor.id,
      now: WITHIN_WINDOW,
    });
    expect(result.outcome).toBe('not_found');
    // Untouched.
    expect(await promoCodesRepository.getById(promo.id)).toBeUndefined();
  });
});

describe('promoCodesRepository.redeem — cap boundary & normalization', () => {
  it('cap boundary: the last unit redeems (reaching the cap); the next company is exhausted', async () => {
    const promo = await promoCodeFactory({
      values: {
        code: 'LASTONE',
        grantMinor: 5000,
        perCodeRedemptionCap: 1,
        redeemedCount: 0,
        validFrom: WINDOW_FROM,
        validUntil: WINDOW_UNTIL,
      },
    });
    const companyA = await companyFactory();
    const companyB = await companyFactory();
    const actorA = await userFactory();
    const actorB = await userFactory();

    const first = await promoCodesRepository.redeem({
      rawCode: 'LASTONE',
      companyId: companyA.id,
      redeemedByUserId: actorA.id,
      now: WITHIN_WINDOW,
    });
    expect(first.outcome).toBe('redeemed');
    if (first.outcome !== 'redeemed') throw new Error('expected redeemed');
    expect(first.redeemedCount).toBe(1);
    expect(first.perCodeRedemptionCap).toBe(1);

    // The cap is now reached — the next distinct company is refused.
    const second = await promoCodesRepository.redeem({
      rawCode: 'LASTONE',
      companyId: companyB.id,
      redeemedByUserId: actorB.id,
      now: WITHIN_WINDOW,
    });
    expect(second.outcome).toBe('exhausted');

    expect((await promoCodesRepository.getById(promo.id))?.redeemedCount).toBe(1);
    expect(await redemptionRowsFor(promo.id)).toHaveLength(1);
  });

  it('normalizes the entered code: a lower-case padded entry redeems the upper-cased stored code, and the ledger key is the promo id', async () => {
    const promo = await promoCodeFactory({
      values: {
        code: 'WELCOME50', // stored uppercase
        grantMinor: 5000,
        validFrom: WINDOW_FROM,
        validUntil: WINDOW_UNTIL,
      },
    });
    const company = await companyFactory();
    const actor = await userFactory();

    const result = await promoCodesRepository.redeem({
      rawCode: '  welcome50  ', // raw, lower-case, padded
      companyId: company.id,
      redeemedByUserId: actor.id,
      now: WITHIN_WINDOW,
    });

    expect(result.outcome).toBe('redeemed');
    expect((await promoCodesRepository.getById(promo.id))?.redeemedCount).toBe(1);

    const wallet = await creditWalletsRepository.findByCompanyId(company.id);
    expect(wallet).toBeDefined();
    if (wallet === undefined) throw new Error('wallet missing');
    const ledger = await creditLedgerRepository.listByWallet(wallet.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.idempotencyKey).toBe(`promo:${wallet.id}:${promo.id}`);
  });
});
