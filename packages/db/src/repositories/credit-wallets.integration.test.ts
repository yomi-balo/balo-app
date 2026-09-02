import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isWalletMandateActive, isWalletCardReusableOnSession } from '@balo/shared/credit';
import { creditWallets, type CreditWallet } from '../schema';
import { db } from '../client';
import { creditWalletFactory } from '../test/factories';
import { companyFactory } from '../test/factories/company.factory';
import { creditWalletsRepository } from './credit-wallets';
import type { DbExecutor } from './_shared/db-executor';

/**
 * Integration tests for `creditWalletsRepository` (BAL-376). Uses the in-harness `db`
 * (per-test transaction, auto-rolled-back). Factories only — never raw inserts.
 */

/** The wallet ids of a result list, in the returned order. */
function ids(wallets: CreditWallet[]): string[] {
  return wallets.map((w) => w.id);
}

/** Postgres' integrity-constraint-violation code for a failed CHECK. */
const CHECK_VIOLATION = '23514';

interface PgErrorFacts {
  code: string;
  constraint: string;
}

/** Narrow an unknown throwable to the postgres-js error fields we assert on. */
function pgErrorFacts(err: unknown): PgErrorFacts | null {
  if (typeof err !== 'object' || err === null) return null;
  const record = err as Record<string, unknown>;
  const code = record['code'];
  if (typeof code !== 'string') return null;
  const constraint = record['constraint_name'];
  return { code, constraint: typeof constraint === 'string' ? constraint : '' };
}

/**
 * Run a statement expected to violate a constraint and return the Postgres error's facts.
 *
 * ⚠ THE NESTED TRANSACTION IS LOAD-BEARING, not decoration. A constraint violation puts the
 * enclosing transaction into the aborted state, and this whole FILE shares ONE per-test
 * transaction (`setup-integration.ts`). Without the nesting — which Drizzle emits as a
 * SAVEPOINT on the max:1 pool — every statement after the first constraint test would fail
 * with 25P02 ("current transaction is aborted") instead of its own reason, and the real
 * failure would be buried in downstream noise. `ROLLBACK TO SAVEPOINT` is one of the few
 * commands Postgres still accepts in an aborted transaction, so the outer one survives intact.
 */
async function expectConstraintViolation(
  run: (exec: DbExecutor) => Promise<unknown>
): Promise<PgErrorFacts> {
  try {
    await db.transaction(async (tx) => {
      await run(tx);
    });
  } catch (err: unknown) {
    const facts = pgErrorFacts(err);
    if (facts === null) {
      throw new Error(`expected a Postgres error, got: ${String(err)}`);
    }
    return facts;
  }
  throw new Error('expected a constraint violation, but the statement succeeded');
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
    // Top-up redesign — saved-card display columns default to null (no card on file). All four
    // move together, so this is also the "all-null arm" of the all-or-none CHECK holding.
    expect(wallet.cardBrand).toBeNull();
    expect(wallet.cardLast4).toBeNull();
    expect(wallet.cardExpMonth).toBeNull();
    expect(wallet.cardExpYear).toBeNull();
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

  it('REFUSES active → pending (a confirmed mandate is never stranded un-chargeable)', async () => {
    // The race this closes: `confirmSavedCardMandate` calls setupIntents.create({confirm:true}),
    // which can reach `succeeded` DURING the call — so Stripe may queue setup_intent.succeeded
    // (→ applyMandate → 'active') before the caller's own `pending` write lands. Without this
    // guard the webhook's 'active' is stomped back to 'pending' permanently, and because
    // `isWalletMandateActive` is a conjunction including the status, auto-top-up and overdraft
    // settlement silently stop firing for that wallet with nothing to retry them.
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_r',
      stripePaymentMethodId: 'pm_r',
      mandateRef: 'seti_r',
      mandateStatus: 'active',
    });

    const after = await creditWalletsRepository.applyMandateStatus(db, wallet.id, 'pending');

    expect(after.mandateStatus).toBe('active');
    // The mandate itself is untouched — this is a refused transition, not a partial write.
    expect(after.mandateRef).toBe('seti_r');
    expect(after.stripePaymentMethodId).toBe('pm_r');
  });

  it('still allows active → failed (a mandate that genuinely fails MUST be recorded)', async () => {
    // The guard must be narrow: refusing every downgrade would hide a real mandate failure and
    // leave the wallet looking chargeable when it is not.
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_f',
      stripePaymentMethodId: 'pm_f',
      mandateRef: 'seti_f',
      mandateStatus: 'active',
    });

    const after = await creditWalletsRepository.applyMandateStatus(db, wallet.id, 'failed');
    expect(after.mandateStatus).toBe('failed');
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

describe('creditWalletsRepository.applySavedCardDisplay (top-up redesign)', () => {
  const CARD = { cardBrand: 'visa', cardLast4: '4242', cardExpMonth: 8, cardExpYear: 2028 };

  it('writes both Stripe ids + the four display columns and never ACTIVATES a mandate', async () => {
    // ⚠ THIS IS THE SAFETY PROPERTY OF THE WHOLE SAVED-CARD DESIGN (plan §1.1 / R4). Every
    // off-session charge path gates on `isWalletMandateActive`, which requires
    // `mandate_status = 'active'`. Persisting a payment-method id here must therefore NOT be
    // able to enable an unattended charge — so the status is asserted null BEFORE and AFTER.
    const { wallet } = await creditWalletFactory();
    expect(wallet.mandateStatus).toBeNull();

    const updated = await creditWalletsRepository.applySavedCardDisplay(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_saved_1',
      stripePaymentMethodId: 'pm_saved_1',
      card: CARD,
    });

    expect(updated.stripeCustomerId).toBe('cus_saved_1');
    expect(updated.stripePaymentMethodId).toBe('pm_saved_1');
    expect(updated.cardBrand).toBe('visa');
    expect(updated.cardLast4).toBe('4242');
    expect(updated.cardExpMonth).toBe(8);
    expect(updated.cardExpYear).toBe(2028);
    // The status did not move, and no mandate ref was invented.
    expect(updated.mandateStatus).toBeNull();
    expect(updated.mandateRef).toBeNull();

    // Persisted — re-read from the database, not just the RETURNING row.
    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.mandateStatus).toBeNull();
    expect(persisted?.cardLast4).toBe('4242');
    expect(persisted?.stripePaymentMethodId).toBe('pm_saved_1');
  });

  it('PRESERVES an active mandate when the SAME card is re-persisted', async () => {
    // The legitimate case: a returning buyer pays again with the card their mandate was
    // captured against. Nothing about the consent changed, so nothing about it may be cleared.
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_m',
      stripePaymentMethodId: 'pm_m',
      mandateRef: 'seti_m',
      mandateStatus: 'active',
    });

    const updated = await creditWalletsRepository.applySavedCardDisplay(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_m',
      stripePaymentMethodId: 'pm_m',
      card: CARD,
    });

    expect(updated.stripePaymentMethodId).toBe('pm_m');
    expect(updated.mandateStatus).toBe('active');
    expect(updated.mandateRef).toBe('seti_m');
    // The display columns still land.
    expect(updated.cardLast4).toBe('4242');
    // Still off-session chargeable — the mandate covers exactly this card.
    expect(isWalletMandateActive(updated)).toBe(true);
  });

  it('REVOKES the mandate when a DIFFERENT card is persisted (no unconsented off-session charge)', async () => {
    // ⚠ THE PAYMENT-MANIPULATION GUARD. `isWalletMandateActive` is a conjunction over three
    // columns. Moving `stripe_payment_method_id` while `mandate_status` stayed 'active' would
    // silently re-point a live off-session mandate at a card that never went through a
    // SetupIntent — every unattended charge path (overdraft settlement, auto-top-up) re-reads
    // the wallet at charge time and charges whatever id is stored. So a card CHANGE revokes the
    // consent captured for the previous card, in the same statement.
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_m',
      stripePaymentMethodId: 'pm_m',
      mandateRef: 'seti_m',
      mandateStatus: 'active',
    });

    const updated = await creditWalletsRepository.applySavedCardDisplay(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_m',
      stripePaymentMethodId: 'pm_m2',
      card: CARD,
    });

    // The new card is on file for DISPLAY and on-session reuse …
    expect(updated.stripePaymentMethodId).toBe('pm_m2');
    expect(updated.cardBrand).toBe('visa');
    expect(updated.cardLast4).toBe('4242');
    // … but the consent captured for pm_m is gone, and no stale ref survives to name it.
    expect(updated.mandateStatus).toBeNull();
    expect(updated.mandateRef).toBeNull();
    // The property that matters, stated in the predicate the charge paths actually gate on.
    expect(isWalletMandateActive(updated)).toBe(false);
    expect(isWalletCardReusableOnSession(updated)).toBe(true);

    // Persisted — re-read from the database, not just the RETURNING row.
    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.mandateStatus).toBeNull();
    expect(persisted?.mandateRef).toBeNull();
    expect(persisted?.stripePaymentMethodId).toBe('pm_m2');
  });

  it('is last-writer-wins — a second card replaces the first', async () => {
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.applySavedCardDisplay(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_1',
      stripePaymentMethodId: 'pm_1',
      card: CARD,
    });
    const second = await creditWalletsRepository.applySavedCardDisplay(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_1',
      stripePaymentMethodId: 'pm_2',
      card: { cardBrand: 'amex', cardLast4: '0005', cardExpMonth: 12, cardExpYear: 2030 },
    });

    expect(second.cardBrand).toBe('amex');
    expect(second.cardLast4).toBe('0005');
    expect(second.cardExpMonth).toBe(12);
    expect(second.cardExpYear).toBe(2030);
    expect(second.stripePaymentMethodId).toBe('pm_2');
  });

  it('composes under a caller transaction (the webhook passes its tx)', async () => {
    const { wallet } = await creditWalletFactory();
    await db.transaction((tx) =>
      creditWalletsRepository.applySavedCardDisplay(tx, {
        walletId: wallet.id,
        stripeCustomerId: 'cus_tx',
        stripePaymentMethodId: 'pm_tx',
        card: CARD,
      })
    );
    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.cardLast4).toBe('4242');
    expect(persisted?.mandateStatus).toBeNull();
  });

  it('throws for an unknown wallet id', async () => {
    await expect(
      creditWalletsRepository.applySavedCardDisplay(db, {
        walletId: '00000000-0000-0000-0000-000000000000',
        stripeCustomerId: 'cus_x',
        stripePaymentMethodId: 'pm_x',
        card: CARD,
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe('creditWalletsRepository.applyMandate with card display (top-up redesign)', () => {
  it('writes the mandate columns AND the four display columns in ONE statement', async () => {
    // One UPDATE is what makes the all-or-none CHECK safe here: the constraint can never
    // observe a half-written card, because there is no intermediate statement.
    const { wallet } = await creditWalletFactory();
    const updated = await creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_both',
      stripePaymentMethodId: 'pm_both',
      mandateRef: 'seti_both',
      mandateStatus: 'active',
      card: { cardBrand: 'mastercard', cardLast4: '4444', cardExpMonth: 1, cardExpYear: 2029 },
    });

    expect(updated.mandateStatus).toBe('active');
    expect(updated.mandateRef).toBe('seti_both');
    expect(updated.cardBrand).toBe('mastercard');
    expect(updated.cardLast4).toBe('4444');
    expect(updated.cardExpMonth).toBe(1);
    expect(updated.cardExpYear).toBe(2029);

    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.cardBrand).toBe('mastercard');
    expect(persisted?.mandateStatus).toBe('active');
  });

  it('WITHOUT card leaves the display columns exactly as they were (a Stripe read failure never blanks a card)', async () => {
    // `retrieveCardDisplay` fails soft and yields no `card`. That must not wipe a card the
    // buyer can still see — it is a cosmetic miss, and blanking would be a visible regression.
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.applySavedCardDisplay(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_pre',
      stripePaymentMethodId: 'pm_pre',
      card: { cardBrand: 'visa', cardLast4: '4242', cardExpMonth: 8, cardExpYear: 2028 },
    });

    const updated = await creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_post',
      stripePaymentMethodId: 'pm_post',
      mandateRef: 'seti_post',
      mandateStatus: 'active',
    });

    expect(updated.mandateStatus).toBe('active');
    expect(updated.stripePaymentMethodId).toBe('pm_post');
    // Untouched.
    expect(updated.cardBrand).toBe('visa');
    expect(updated.cardLast4).toBe('4242');
    expect(updated.cardExpMonth).toBe(8);
    expect(updated.cardExpYear).toBe(2028);
  });

  it('WITHOUT card on a wallet that never had one leaves all four null (no partial row)', async () => {
    const { wallet } = await creditWalletFactory();
    const updated = await creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_none',
      stripePaymentMethodId: 'pm_none',
      mandateRef: 'seti_none',
      mandateStatus: 'active',
    });
    expect(updated.cardBrand).toBeNull();
    expect(updated.cardLast4).toBeNull();
    expect(updated.cardExpMonth).toBeNull();
    expect(updated.cardExpYear).toBeNull();
  });
});

describe('credit_wallets saved-card CHECK constraints (migration 0079)', () => {
  // These are only provable against real Postgres — the repository's typed `CardDisplayInput`
  // makes a partial write unrepresentable in TypeScript, so the constraints are asserted with
  // raw SQL. That is deliberate: the CHECK is the contract for ANY writer, including a future
  // one that does not go through this repository.

  it('all-or-none rejects a partial write (brand + last4 without the expiry)', async () => {
    const { wallet } = await creditWalletFactory();
    const facts = await expectConstraintViolation((exec) =>
      exec.execute(sql`
        UPDATE credit_wallets
        SET card_brand = 'visa', card_last4 = '4242'
        WHERE id = ${wallet.id}
      `)
    );
    expect(facts.code).toBe(CHECK_VIOLATION);
    expect(facts.constraint).toBe('credit_wallets_card_display_all_or_none');
  });

  it('all-or-none rejects clearing only ONE of the four on a fully-populated card', async () => {
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.applySavedCardDisplay(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_p',
      stripePaymentMethodId: 'pm_p',
      card: { cardBrand: 'visa', cardLast4: '4242', cardExpMonth: 8, cardExpYear: 2028 },
    });

    const facts = await expectConstraintViolation((exec) =>
      exec.execute(sql`UPDATE credit_wallets SET card_exp_year = NULL WHERE id = ${wallet.id}`)
    );
    expect(facts.code).toBe(CHECK_VIOLATION);
    expect(facts.constraint).toBe('credit_wallets_card_display_all_or_none');

    // The savepoint rolled back — the row is intact, which also proves the helper works.
    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.cardExpYear).toBe(2028);
  });

  it('all-or-none ACCEPTS clearing all four together (the all-null arm)', async () => {
    // The positive case, so the two rejections above are not vacuously green: an existing
    // wallet may legitimately return to "no card on file".
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.applySavedCardDisplay(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_c',
      stripePaymentMethodId: 'pm_c',
      card: { cardBrand: 'visa', cardLast4: '4242', cardExpMonth: 8, cardExpYear: 2028 },
    });

    await db.execute(sql`
      UPDATE credit_wallets
      SET card_brand = NULL, card_last4 = NULL, card_exp_month = NULL, card_exp_year = NULL
      WHERE id = ${wallet.id}
    `);

    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.cardBrand).toBeNull();
    expect(persisted?.cardLast4).toBeNull();
  });

  it.each([
    ['too short', '42'],
    ['non-numeric', 'abcd'],
    ['too long', '42424'],
    ['empty', ''],
  ])('last4 format rejects %s (%s)', async (_label, last4) => {
    const { wallet } = await creditWalletFactory();
    const facts = await expectConstraintViolation((exec) =>
      exec.execute(sql`
        UPDATE credit_wallets
        SET card_brand = 'visa', card_last4 = ${last4}, card_exp_month = 8, card_exp_year = 2028
        WHERE id = ${wallet.id}
      `)
    );
    expect(facts.code).toBe(CHECK_VIOLATION);
    expect(facts.constraint).toBe('credit_wallets_card_last4_format');
  });

  it('last4 format ACCEPTS a leading-zero four-digit string (e.g. an Amex 0005)', async () => {
    // `text` + a regex CHECK rather than an integer is exactly so '0005' survives; an integer
    // column would silently store 5 and render "•••• 5".
    const { wallet } = await creditWalletFactory();
    const updated = await creditWalletsRepository.applySavedCardDisplay(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_z',
      stripePaymentMethodId: 'pm_z',
      card: { cardBrand: 'amex', cardLast4: '0005', cardExpMonth: 8, cardExpYear: 2028 },
    });
    expect(updated.cardLast4).toBe('0005');
  });

  it.each([
    ['zero', 0],
    ['thirteen', 13],
    ['negative', -1],
  ])('exp_month range rejects %s (%i)', async (_label, month) => {
    const { wallet } = await creditWalletFactory();
    const facts = await expectConstraintViolation((exec) =>
      exec.execute(sql`
        UPDATE credit_wallets
        SET card_brand = 'visa', card_last4 = '4242', card_exp_month = ${month}, card_exp_year = 2028
        WHERE id = ${wallet.id}
      `)
    );
    expect(facts.code).toBe(CHECK_VIOLATION);
    expect(facts.constraint).toBe('credit_wallets_card_exp_month_range');
  });

  it.each([
    ['the 1 and 12 boundaries are inclusive', 1],
    ['the 1 and 12 boundaries are inclusive', 12],
  ])('exp_month range accepts %s: %i', async (_label, month) => {
    const { wallet } = await creditWalletFactory();
    const updated = await creditWalletsRepository.applySavedCardDisplay(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_b',
      stripePaymentMethodId: 'pm_b',
      card: { cardBrand: 'visa', cardLast4: '4242', cardExpMonth: month, cardExpYear: 2028 },
    });
    expect(updated.cardExpMonth).toBe(month);
  });

  it.each([
    ['a two-digit year mistaken for a full one', 28],
    ['far past', 1999],
    ['far future', 2101],
  ])('exp_year range rejects %s (%i)', async (_label, year) => {
    // The `28` case is the one that matters: Stripe returns `exp_year: 2028`, and a caller that
    // passed the DISPLAY form ("08/28") straight through would be caught here rather than
    // silently storing a card that renders as expired.
    const { wallet } = await creditWalletFactory();
    const facts = await expectConstraintViolation((exec) =>
      exec.execute(sql`
        UPDATE credit_wallets
        SET card_brand = 'visa', card_last4 = '4242', card_exp_month = 8, card_exp_year = ${year}
        WHERE id = ${wallet.id}
      `)
    );
    expect(facts.code).toBe(CHECK_VIOLATION);
    expect(facts.constraint).toBe('credit_wallets_card_exp_year_range');
  });

  it('a fresh wallet row satisfies every card CHECK with no card written (migration safety)', async () => {
    // The property migration 0079 relies on: every PRE-EXISTING wallet row passes all four
    // constraints as written, so the ALTER TABLE needs no backfill and cannot fail on a
    // non-empty database. The Testcontainers harness only ever migrates an EMPTY container
    // (memory `reference_db_migrations_tested_against_empty_db`), so a wallet created BEFORE
    // the constraints are consulted is the closest proof available here.
    const company = await companyFactory();
    const wallet = await creditWalletsRepository.create({ companyId: company.id });
    const rows = await db.select().from(creditWallets).where(eq(creditWallets.id, wallet.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cardBrand).toBeNull();
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
