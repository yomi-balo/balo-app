import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { creditWallets, type CreditWallet } from '../schema';
import { db } from '../client';
import { creditWalletFactory } from '../test/factories';
import { companyFactory } from '../test/factories/company.factory';
import { creditWalletsRepository } from './credit-wallets';

/**
 * Integration tests for `creditWalletsRepository` (BAL-376). Uses the in-harness `db`
 * (per-test transaction, auto-rolled-back). Factories only — never raw inserts.
 */

/** The wallet ids of a result list, in the returned order. */
function ids(wallets: CreditWallet[]): string[] {
  return wallets.map((w) => w.id);
}

describe('creditWalletsRepository.create', () => {
  it('creates one wallet per company with the schema defaults', async () => {
    const company = await companyFactory();
    const wallet = await creditWalletsRepository.create({ companyId: company.id });

    expect(wallet.id).toBeDefined();
    expect(wallet.companyId).toBe(company.id);
    expect(wallet.balanceMinor).toBe(0);
    expect(wallet.currency).toBe('AUD');
    expect(wallet.lowBalanceMode).toBe('notify_only');
    expect(wallet.topupThresholdMinor).toBe(2000);
    expect(wallet.topupReloadMinor).toBe(10_000);
    expect(wallet.overdraftCeilingMinor).toBeNull();
    expect(wallet.expiresAt).toBeNull();
    expect(wallet.stripePaymentMethodId).toBeNull();
    expect(wallet.mandateRef).toBeNull();
    // BAL-382 mandate columns default to null (no default; no mandate ever attempted).
    expect(wallet.stripeCustomerId).toBeNull();
    expect(wallet.mandateStatus).toBeNull();
  });

  it('returns balanceMinor as a JS number (bigint accumulator, mode:number)', async () => {
    const { wallet } = await creditWalletFactory();
    expect(typeof wallet.balanceMinor).toBe('number');
  });

  it('rejects a second wallet for the same company (one-per-company unique)', async () => {
    const company = await companyFactory();
    await creditWalletsRepository.create({ companyId: company.id });
    await expect(creditWalletsRepository.create({ companyId: company.id })).rejects.toThrow();
  });
});

describe('creditWalletsRepository.ensureForCompany (BAL-383 find-or-create)', () => {
  it('creates the wallet with schema defaults when none exists', async () => {
    const company = await companyFactory();
    // Nothing there yet.
    expect(await creditWalletsRepository.findByCompanyId(company.id)).toBeUndefined();

    const wallet = await creditWalletsRepository.ensureForCompany(db, company.id);

    expect(wallet.companyId).toBe(company.id);
    expect(wallet.balanceMinor).toBe(0);
    expect(wallet.currency).toBe('AUD');
    expect(wallet.mandateStatus).toBeNull();

    // Persisted — a subsequent read finds the same row.
    const persisted = await creditWalletsRepository.findByCompanyId(company.id);
    expect(persisted?.id).toBe(wallet.id);
  });

  it('returns the existing wallet when one is already present (no duplicate)', async () => {
    const company = await companyFactory();
    const existing = await creditWalletsRepository.create({ companyId: company.id });

    const wallet = await creditWalletsRepository.ensureForCompany(db, company.id);
    expect(wallet.id).toBe(existing.id);
  });

  it('is idempotent — a second call returns the same wallet id and creates no duplicate', async () => {
    const company = await companyFactory();
    const first = await creditWalletsRepository.ensureForCompany(db, company.id);
    const second = await creditWalletsRepository.ensureForCompany(db, company.id);

    expect(second.id).toBe(first.id);

    // Exactly one wallet exists for the company (the one-per-company unique holds).
    const rows = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.companyId, company.id));
    expect(rows).toHaveLength(1);
  });

  it('composes under a passed transaction handle (tx)', async () => {
    const company = await companyFactory();

    // A nested db.transaction produces a SAVEPOINT on the max:1 pool; ensureForCompany
    // runs on the passed tx and commits into the surrounding per-test transaction.
    const wallet = await db.transaction((tx) =>
      creditWalletsRepository.ensureForCompany(tx, company.id)
    );

    expect(wallet.companyId).toBe(company.id);
    const persisted = await creditWalletsRepository.findByCompanyId(company.id);
    expect(persisted?.id).toBe(wallet.id);
  });
});

describe('creditWalletsRepository reads', () => {
  it('findById returns the wallet', async () => {
    const { wallet } = await creditWalletFactory();
    const found = await creditWalletsRepository.findById(wallet.id);
    expect(found?.id).toBe(wallet.id);
  });

  it('findByCompanyId returns the wallet for the company', async () => {
    const { wallet, companyId } = await creditWalletFactory();
    const found = await creditWalletsRepository.findByCompanyId(companyId);
    expect(found?.id).toBe(wallet.id);
  });

  it('findById returns undefined for an unknown id', async () => {
    const found = await creditWalletsRepository.findById('00000000-0000-0000-0000-000000000000');
    expect(found).toBeUndefined();
  });
});

describe('creditWalletsRepository.updateConfig', () => {
  it('writes each config field and leaves the rest untouched', async () => {
    const { wallet } = await creditWalletFactory();
    const updated = await creditWalletsRepository.updateConfig(wallet.id, {
      lowBalanceMode: 'auto_topup',
      topupThresholdMinor: 5000,
      topupReloadMinor: 25_000,
      overdraftCeilingMinor: 30_000,
      stripePaymentMethodId: 'pm_123',
      mandateRef: 'mandate_xyz',
    });

    expect(updated.lowBalanceMode).toBe('auto_topup');
    expect(updated.topupThresholdMinor).toBe(5000);
    expect(updated.topupReloadMinor).toBe(25_000);
    expect(updated.overdraftCeilingMinor).toBe(30_000);
    expect(updated.stripePaymentMethodId).toBe('pm_123');
    expect(updated.mandateRef).toBe('mandate_xyz');
    // Untouched fields keep their values.
    expect(updated.currency).toBe('AUD');
    expect(updated.balanceMinor).toBe(0);
  });

  it('clears a nullable field back to null (overdraft ceiling → platform default at the caller)', async () => {
    const { wallet } = await creditWalletFactory({ values: { overdraftCeilingMinor: 20_000 } });
    const cleared = await creditWalletsRepository.updateConfig(wallet.id, {
      overdraftCeilingMinor: null,
    });
    expect(cleared.overdraftCeilingMinor).toBeNull();
  });

  it('is a no-op passthrough when given no fields (returns the current row)', async () => {
    const { wallet } = await creditWalletFactory();
    const same = await creditWalletsRepository.updateConfig(wallet.id, {});
    expect(same.id).toBe(wallet.id);
  });

  it('throws for an unknown wallet id', async () => {
    await expect(
      creditWalletsRepository.updateConfig('00000000-0000-0000-0000-000000000000', {
        lowBalanceMode: 'keep_going',
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe('creditWalletsRepository.findExpirableWallets (BAL-380 expiry sweep eligibility)', () => {
  const now = new Date('2027-06-01T00:00:00.000Z');

  it('returns wallets past expiry with a positive balance, oldest expiry first', async () => {
    // Two eligible wallets — expiry BEFORE now, positive balance. Seeded newest-first to
    // prove the ORDER BY expires_at ASC (not insertion order).
    const { wallet: newer } = await creditWalletFactory({
      values: { balanceMinor: 3000, expiresAt: new Date('2027-05-20T00:00:00.000Z') },
    });
    const { wallet: older } = await creditWalletFactory({
      values: { balanceMinor: 5000, expiresAt: new Date('2027-05-01T00:00:00.000Z') },
    });

    const result = await creditWalletsRepository.findExpirableWallets(now);
    expect(ids(result)).toEqual([older.id, newer.id]);
  });

  it('includes a wallet whose expiry is exactly now (inclusive `<= now` boundary)', async () => {
    const { wallet } = await creditWalletFactory({
      values: { balanceMinor: 1000, expiresAt: now },
    });
    const result = await creditWalletsRepository.findExpirableWallets(now);
    expect(ids(result)).toEqual([wallet.id]);
  });

  it('excludes future-dated, zero/negative-balance, and null-expiry wallets', async () => {
    const { wallet: eligible } = await creditWalletFactory({
      values: { balanceMinor: 4000, expiresAt: new Date('2027-05-15T00:00:00.000Z') },
    });
    // Out of band: expiry is in the future.
    await creditWalletFactory({
      values: { balanceMinor: 4000, expiresAt: new Date('2027-07-01T00:00:00.000Z') },
    });
    // Past expiry but nothing to expire (balance == 0).
    await creditWalletFactory({
      values: { balanceMinor: 0, expiresAt: new Date('2027-05-01T00:00:00.000Z') },
    });
    // Past expiry but a negative (overdraft) balance — excluded by `balance_minor > 0`.
    await creditWalletFactory({
      values: { balanceMinor: -200, expiresAt: new Date('2027-05-01T00:00:00.000Z') },
    });
    // Never transacted — expires_at IS NULL.
    await creditWalletFactory({ values: { balanceMinor: 9000, expiresAt: null } });

    const result = await creditWalletsRepository.findExpirableWallets(now);
    expect(ids(result)).toEqual([eligible.id]);
  });
});

describe('creditWalletsRepository.findWalletsExpiringBetween (BAL-380 dormancy bands)', () => {
  const after = new Date('2027-07-30T00:00:00.000Z');
  const until = new Date('2027-07-31T00:00:00.000Z');

  it('returns wallets in the half-open (after, until] band, oldest expiry first', async () => {
    const { wallet: later } = await creditWalletFactory({
      values: { balanceMinor: 2000, expiresAt: new Date('2027-07-30T18:00:00.000Z') },
    });
    const { wallet: earlier } = await creditWalletFactory({
      values: { balanceMinor: 2000, expiresAt: new Date('2027-07-30T06:00:00.000Z') },
    });

    const result = await creditWalletsRepository.findWalletsExpiringBetween(after, until);
    expect(ids(result)).toEqual([earlier.id, later.id]);
  });

  it('excludes the open lower bound (== after) but includes the closed upper bound (== until)', async () => {
    // expires_at == after → excluded (strictly `> after`).
    await creditWalletFactory({ values: { balanceMinor: 2000, expiresAt: after } });
    // expires_at == until → included (`<= until`).
    const { wallet: onUpper } = await creditWalletFactory({
      values: { balanceMinor: 2000, expiresAt: until },
    });

    const result = await creditWalletsRepository.findWalletsExpiringBetween(after, until);
    expect(ids(result)).toEqual([onUpper.id]);
  });

  it('excludes wallets outside the band, zero-balance, and null-expiry wallets', async () => {
    const { wallet: inBand } = await creditWalletFactory({
      values: { balanceMinor: 2000, expiresAt: new Date('2027-07-30T12:00:00.000Z') },
    });
    // Before the band (at/under `after`).
    await creditWalletFactory({
      values: { balanceMinor: 2000, expiresAt: new Date('2027-07-29T12:00:00.000Z') },
    });
    // After the band (past `until`).
    await creditWalletFactory({
      values: { balanceMinor: 2000, expiresAt: new Date('2027-08-01T12:00:00.000Z') },
    });
    // In band but no balance.
    await creditWalletFactory({
      values: { balanceMinor: 0, expiresAt: new Date('2027-07-30T09:00:00.000Z') },
    });
    // Never transacted.
    await creditWalletFactory({ values: { balanceMinor: 2000, expiresAt: null } });

    const result = await creditWalletsRepository.findWalletsExpiringBetween(after, until);
    expect(ids(result)).toEqual([inBand.id]);
  });
});

describe('creditWalletsRepository.applyMandate / applyMandateStatus (BAL-382)', () => {
  it('applyMandate writes customer + payment method + mandate ref + mandate_status=active', async () => {
    const { wallet } = await creditWalletFactory();

    const updated = await creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_123',
      stripePaymentMethodId: 'pm_123',
      mandateRef: 'seti_123',
      mandateStatus: 'active',
    });

    expect(updated.stripeCustomerId).toBe('cus_123');
    expect(updated.stripePaymentMethodId).toBe('pm_123');
    expect(updated.mandateRef).toBe('seti_123');
    expect(updated.mandateStatus).toBe('active');

    // Persisted (re-read from the DB).
    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.stripeCustomerId).toBe('cus_123');
    expect(persisted?.stripePaymentMethodId).toBe('pm_123');
    expect(persisted?.mandateRef).toBe('seti_123');
    expect(persisted?.mandateStatus).toBe('active');
  });

  it('applyMandateStatus flips only the status (active → failed), leaving mandate columns intact', async () => {
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_abc',
      stripePaymentMethodId: 'pm_abc',
      mandateRef: 'seti_abc',
      mandateStatus: 'active',
    });

    const failed = await creditWalletsRepository.applyMandateStatus(db, wallet.id, 'failed');
    expect(failed.mandateStatus).toBe('failed');
    // The customer / payment-method / mandate-ref columns are untouched.
    expect(failed.stripeCustomerId).toBe('cus_abc');
    expect(failed.stripePaymentMethodId).toBe('pm_abc');
    expect(failed.mandateRef).toBe('seti_abc');
  });

  it('applyMandateStatus sets pending on a brand-new wallet (null → pending)', async () => {
    const { wallet } = await creditWalletFactory();
    expect(wallet.mandateStatus).toBeNull();

    const pending = await creditWalletsRepository.applyMandateStatus(db, wallet.id, 'pending');
    expect(pending.mandateStatus).toBe('pending');
    // No customer attached yet.
    expect(pending.stripeCustomerId).toBeNull();
  });

  it('applyMandate throws for an unknown wallet id', async () => {
    await expect(
      creditWalletsRepository.applyMandate(db, {
        walletId: '00000000-0000-0000-0000-000000000000',
        stripeCustomerId: 'cus_x',
        stripePaymentMethodId: 'pm_x',
        mandateRef: 'seti_x',
        mandateStatus: 'active',
      })
    ).rejects.toThrow(/not found/i);
  });

  it('applyMandateStatus throws for an unknown wallet id', async () => {
    await expect(
      creditWalletsRepository.applyMandateStatus(
        db,
        '00000000-0000-0000-0000-000000000000',
        'failed'
      )
    ).rejects.toThrow(/not found/i);
  });
});

describe('creditWalletsRepository.setPendingTopupAt (BAL-379 single-in-flight marker)', () => {
  it('arms then clears the pending_topup_at marker (round-trip)', async () => {
    const { wallet } = await creditWalletFactory();
    // Fresh wallet — no marker.
    expect((await creditWalletsRepository.findById(wallet.id))?.pendingTopupAt).toBeNull();

    const at = new Date('2027-03-01T10:00:00.000Z');
    await creditWalletsRepository.setPendingTopupAt(wallet.id, at);
    const armed = await creditWalletsRepository.findById(wallet.id);
    expect(armed?.pendingTopupAt?.getTime()).toBe(at.getTime());

    await creditWalletsRepository.setPendingTopupAt(wallet.id, null);
    const cleared = await creditWalletsRepository.findById(wallet.id);
    expect(cleared?.pendingTopupAt).toBeNull();
  });

  it('composes under a caller transaction (exec) — the arm is visible after commit', async () => {
    const { wallet } = await creditWalletFactory();
    const at = new Date('2027-03-02T12:00:00.000Z');
    await db.transaction(async (tx) => {
      await creditWalletsRepository.setPendingTopupAt(wallet.id, at, tx);
    });
    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.pendingTopupAt?.getTime()).toBe(at.getTime());
  });
});
