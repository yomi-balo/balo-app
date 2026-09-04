import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  isWalletMandateActive,
  isWalletCardReusableOnSession,
  CARD_BACKED_LOW_BALANCE_MODES,
} from '@balo/shared/credit';
import { auditEvents, companies, creditWallets, type CreditWallet } from '../schema';
import { db } from '../client';
import { creditWalletFactory, userFactory } from '../test/factories';
import { companyFactory } from '../test/factories/company.factory';
import { creditWalletsRepository, type UpdateWalletConfigResult } from './credit-wallets';
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

/**
 * FIX ROUND (F9) — the `expect(result.outcome).toBe('written'); if (result.outcome !== 'written')
 * throw …` narrowing shape repeated 8× across this describe block. `UpdateWalletConfigResult` is a
 * discriminated union with no other outcome a passing assertion could leave `result` as, so this
 * is the ONE place that narrows it; every case below reads `expectWritten(result)` instead of
 * restating the guard. Kept as a genuine `expect` + throw (not a bare type assertion) so a
 * regression that starts returning `refused_no_card_on_file` from a case that must not still fails
 * LOUDLY, with Vitest's own assertion message, rather than a generic property-of-undefined crash.
 */
function expectWritten(result: UpdateWalletConfigResult): CreditWallet {
  expect(result.outcome).toBe('written');
  if (result.outcome !== 'written') {
    throw new Error(`expected outcome "written", got "${result.outcome}"`);
  }
  return result.wallet;
}

describe('creditWalletsRepository.updateConfig', () => {
  it('writes each config field and leaves the rest untouched', async () => {
    const { wallet } = await creditWalletFactory();
    // BAL-524 arm 2 (§2.4 of the plan): this write names a CARD-BACKED mode (`auto_topup`) AND
    // establishes `stripePaymentMethodId` in the SAME call, on a wallet that started cardless.
    // That is deliberate — it is exactly the same-write-establishes-the-card shape the guard
    // must allow (the purchase path's config-then-charge ordering), so DO NOT "simplify" this
    // to a bare `isNotNull` precondition without re-reading BAL-524's plan §2.4 — that would
    // red this test for the wrong reason.
    const result = await creditWalletsRepository.updateConfig(wallet.id, {
      lowBalanceMode: 'auto_topup',
      topupThresholdMinor: 5000,
      topupReloadMinor: 25_000,
      overdraftCeilingMinor: 30_000,
      stripePaymentMethodId: 'pm_123',
      mandateRef: 'mandate_xyz',
    });

    const updated = expectWritten(result);

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
    const result = await creditWalletsRepository.updateConfig(wallet.id, {
      overdraftCeilingMinor: null,
    });
    expect(expectWritten(result).overdraftCeilingMinor).toBeNull();
  });

  it('is a no-op passthrough when given no fields (returns the current row)', async () => {
    const { wallet } = await creditWalletFactory();
    const result = await creditWalletsRepository.updateConfig(wallet.id, {});
    expect(expectWritten(result).id).toBe(wallet.id);
  });

  it('throws for an unknown wallet id', async () => {
    // Also exercises the new 0-row disambiguation (BAL-524): with no `WHERE` guard active
    // (`keep_going` on a wallet id that does not exist at all), 0 rows can only mean "missing
    // wallet" — the follow-up `findById` on the guarded path is not even reached. Must keep
    // throwing; do NOT weaken this into a `refused_no_card_on_file` result.
    await expect(
      creditWalletsRepository.updateConfig('00000000-0000-0000-0000-000000000000', {
        lowBalanceMode: 'keep_going',
      })
    ).rejects.toThrow(/not found/i);
  });

  describe('BAL-524 — card-backed mode write guard', () => {
    it.each(CARD_BACKED_LOW_BALANCE_MODES)(
      'refuses %s on a cardless wallet — 0 rows affected, nothing written',
      async (mode) => {
        const { wallet } = await creditWalletFactory();
        expect(wallet.stripePaymentMethodId).toBeNull();

        const result = await creditWalletsRepository.updateConfig(wallet.id, {
          lowBalanceMode: mode,
        });

        expect(result).toEqual({ outcome: 'refused_no_card_on_file' });

        const persisted = await creditWalletsRepository.findById(wallet.id);
        expect(persisted?.lowBalanceMode).toBe('notify_only');
      }
    );

    it('allows a card-backed mode on a wallet that already HAS a card — the guard is not a blanket ban', async () => {
      const { wallet } = await creditWalletFactory({
        values: { stripePaymentMethodId: 'pm_existing' },
      });

      const result = await creditWalletsRepository.updateConfig(wallet.id, {
        lowBalanceMode: 'auto_topup',
      });

      expect(expectWritten(result).lowBalanceMode).toBe('auto_topup');
    });

    it('writes notify_only on a cardless wallet normally — the guard is card-backed-only', async () => {
      const { wallet } = await creditWalletFactory();

      const result = await creditWalletsRepository.updateConfig(wallet.id, {
        lowBalanceMode: 'notify_only',
      });

      expect(expectWritten(result).lowBalanceMode).toBe('notify_only');
    });

    it('writes a non-mode field on a cardless wallet with no collateral damage', async () => {
      const { wallet } = await creditWalletFactory();

      const result = await creditWalletsRepository.updateConfig(wallet.id, {
        overdraftCeilingMinor: 12_000,
      });

      const updated = expectWritten(result);
      expect(updated.overdraftCeilingMinor).toBe(12_000);
      expect(updated.lowBalanceMode).toBe('notify_only');
    });

    it('D3 — the exemption allows a card-backed mode on a CARDLESS wallet: the purchase path still works', async () => {
      const { wallet } = await creditWalletFactory();
      expect(wallet.stripePaymentMethodId).toBeNull();

      const result = await creditWalletsRepository.updateConfig(
        wallet.id,
        { lowBalanceMode: 'auto_topup' },
        'card_is_established_by_this_same_operation'
      );

      expect(expectWritten(result).lowBalanceMode).toBe('auto_topup');
    });

    it('F5 — an empty-string stripePaymentMethodId is treated as ABSENT, not as an established card (defence-in-depth)', async () => {
      const { wallet } = await creditWalletFactory();
      expect(wallet.stripePaymentMethodId).toBeNull();

      const result = await creditWalletsRepository.updateConfig(wallet.id, {
        lowBalanceMode: 'auto_topup',
        stripePaymentMethodId: '',
      });

      expect(result).toEqual({ outcome: 'refused_no_card_on_file' });

      // Nothing written — in particular NOT `stripe_payment_method_id: ''`, which arm 3's
      // `isNotNull` WHERE would otherwise vouch for on every later write.
      const persisted = await creditWalletsRepository.findById(wallet.id);
      expect(persisted?.lowBalanceMode).toBe('notify_only');
      expect(persisted?.stripePaymentMethodId).toBeNull();
    });

    it('arm 1 — a card-backed mode + an explicit payment-method clear is refused even though the row HAS a card', async () => {
      const { wallet } = await creditWalletFactory({
        values: { stripePaymentMethodId: 'pm_existing', lowBalanceMode: 'keep_going' },
      });

      const result = await creditWalletsRepository.updateConfig(wallet.id, {
        lowBalanceMode: 'auto_topup',
        stripePaymentMethodId: null,
      });

      expect(result).toEqual({ outcome: 'refused_no_card_on_file' });

      // Nothing written: the card AND the old mode are both intact.
      const persisted = await creditWalletsRepository.findById(wallet.id);
      expect(persisted?.stripePaymentMethodId).toBe('pm_existing');
      expect(persisted?.lowBalanceMode).toBe('keep_going');
    });

    it('arm 2 — a card-backed mode + the SAME-write payment method lands together on a cardless wallet', async () => {
      const { wallet } = await creditWalletFactory();

      const result = await creditWalletsRepository.updateConfig(wallet.id, {
        lowBalanceMode: 'keep_going',
        stripePaymentMethodId: 'pm_new',
      });

      const updated = expectWritten(result);
      expect(updated.lowBalanceMode).toBe('keep_going');
      expect(updated.stripePaymentMethodId).toBe('pm_new');
    });

    /**
     * BAL-524 — the race, expressed SEQUENTIALLY. The integration harness runs a `max:1` pool
     * inside one per-test transaction (memory `db_integration_harness_no_concurrency`), so
     * genuine concurrency is not expressible here — two "simultaneous" statements would
     * serialise on the same connection inside the same transaction. This pins the END STATE the
     * race produces: a concurrent card removal commits first, then the stale web write (default
     * guard) is refused, never landing the forbidden state.
     *
     * This does NOT prove statement-level isolation — this harness cannot. The isolation claim
     * rests on the write being a single `UPDATE … WHERE` (Postgres re-checks the predicate under
     * the row lock), not a read followed by a write — which is why the invariant is in SQL, not
     * `apps/web`. Do not "fix" this with `Promise.all` — on a max:1 pool that is sequential
     * execution wearing a costume.
     */
    it('the TOCTOU race: a concurrent card removal wins, and the stale write is refused', async () => {
      const { wallet } = await creditWalletFactory({
        values: { lowBalanceMode: 'auto_topup', stripePaymentMethodId: 'pm_going_away' },
      });
      const actor = await userFactory();

      // The concurrent removal, committed first.
      await db.transaction((tx) =>
        creditWalletsRepository.clearSavedCardAndReconcileMode(tx, wallet.id, {
          actorUserId: actor.id,
          source: 'user_initiated',
        })
      );

      // The stale web write — read the wallet before the removal, writes after. Default guard.
      const result = await creditWalletsRepository.updateConfig(wallet.id, {
        lowBalanceMode: 'auto_topup',
      });

      expect(result).toEqual({ outcome: 'refused_no_card_on_file' });

      const persisted = await creditWalletsRepository.findById(wallet.id);
      expect(persisted?.lowBalanceMode).toBe('notify_only');
      expect(persisted?.stripePaymentMethodId).toBeNull();
    });
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

  it('ACCEPTS a fully-populated card row with a NULL card_updated_at (BAL-515 — the column must NOT join the all-or-none CHECK)', async () => {
    // ⚠ THE ONE STATEMENT IN MIGRATION 0081 THAT COULD HAVE FAILED ON PRODUCTION DATA.
    // Migration 0080 already shipped, so `credit_wallets` rows exist RIGHT NOW with all four
    // card display columns populated and no `card_updated_at` — the column did not exist yet.
    // Folding `card_updated_at` into `credit_wallets_card_display_all_or_none` would make every
    // one of those rows violate the constraint the moment 0081 validated it, and the
    // Testcontainers harness only ever migrates an EMPTY container
    // (memory `reference_db_migrations_tested_against_empty_db`), so that failure would ship
    // green. This test reconstructs that exact shape by hand and asserts Postgres accepts it.
    //
    // Raw SQL deliberately: every repository writer STAMPS `card_updated_at`, so the hazardous
    // combination is unreachable through the typed API — which is precisely why the constraint,
    // not the API, has to be the thing under test.
    const { wallet } = await creditWalletFactory();
    await db.execute(sql`
      UPDATE credit_wallets
      SET card_brand = 'visa',
          card_last4 = '4242',
          card_exp_month = 8,
          card_exp_year = 2028,
          card_updated_at = NULL
      WHERE id = ${wallet.id}
    `);

    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.cardBrand).toBe('visa');
    expect(persisted?.cardLast4).toBe('4242');
    expect(persisted?.cardExpMonth).toBe(8);
    expect(persisted?.cardExpYear).toBe(2028);
    // The provenance stays NULL: "never refreshed" is a legitimate state, not a partial row.
    expect(persisted?.cardUpdatedAt).toBeNull();
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

describe('creditWalletsRepository auto-top-up marker (BAL-379 / BAL-515 correlation)', () => {
  /**
   * BAL-515 replaced the timestamp-only `setPendingTopupAt` with three correlated methods. The
   * point of the change is that `pending_topup_at` alone names no crossing, so nothing could
   * derive the ledger key `auto_topup:{walletId}:{triggeringEntryId}` and test it for absence —
   * which is how a charged-but-uncredited reload became untraceable once the marker self-healed.
   * These tests pin the correlation, not just the timestamp.
   */

  it('armPendingTopup writes the marker AND its triggering entry id, and NULLS any stale PI id', async () => {
    const { wallet } = await creditWalletFactory();
    expect((await creditWalletsRepository.findById(wallet.id))?.pendingTopupAt).toBeNull();

    // Seed a stale PaymentIntent id from a PREVIOUS crossing, so "nulled" is a real assertion
    // and not a fresh row's default. Inheriting it would aim the reconcile at the wrong charge.
    const firstEntryId = randomUUID();
    await creditWalletsRepository.armPendingTopup({
      walletId: wallet.id,
      at: new Date('2027-03-01T09:00:00.000Z'),
      triggeringEntryId: firstEntryId,
    });
    await creditWalletsRepository.recordPendingTopupPaymentIntent({
      walletId: wallet.id,
      triggeringEntryId: firstEntryId,
      paymentIntentId: 'pi_stale_previous_crossing',
    });

    const at = new Date('2027-03-01T10:00:00.000Z');
    const triggeringEntryId = randomUUID();
    await creditWalletsRepository.armPendingTopup({ walletId: wallet.id, at, triggeringEntryId });

    const armed = await creditWalletsRepository.findById(wallet.id);
    expect(armed?.pendingTopupAt?.getTime()).toBe(at.getTime());
    expect(armed?.pendingTopupTriggeringEntryId).toBe(triggeringEntryId);
    expect(armed?.pendingTopupPaymentIntentId).toBeNull();
  });

  it('composes under a caller transaction (exec) — the phase-1 locked txn arms both columns', async () => {
    const { wallet } = await creditWalletFactory();
    const at = new Date('2027-03-02T12:00:00.000Z');
    const triggeringEntryId = randomUUID();
    await db.transaction(async (tx) => {
      await creditWalletsRepository.armPendingTopup(
        { walletId: wallet.id, at, triggeringEntryId },
        tx
      );
    });
    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.pendingTopupAt?.getTime()).toBe(at.getTime());
    expect(persisted?.pendingTopupTriggeringEntryId).toBe(triggeringEntryId);
  });

  it('recordPendingTopupPaymentIntent stamps the PI id and returns true on a MATCHING entry id', async () => {
    const { wallet } = await creditWalletFactory();
    const triggeringEntryId = randomUUID();
    await creditWalletsRepository.armPendingTopup({
      walletId: wallet.id,
      at: new Date('2027-03-03T10:00:00.000Z'),
      triggeringEntryId,
    });

    const stamped = await creditWalletsRepository.recordPendingTopupPaymentIntent({
      walletId: wallet.id,
      triggeringEntryId,
      paymentIntentId: 'pi_live_1',
    });
    expect(stamped).toBe(true);

    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.pendingTopupPaymentIntentId).toBe('pi_live_1');
    // The marker and its correlation are untouched by the stamp.
    expect(persisted?.pendingTopupTriggeringEntryId).toBe(triggeringEntryId);
  });

  it('recordPendingTopupPaymentIntent returns FALSE and writes NOTHING when the marker was re-armed for another crossing', async () => {
    // ⚠ THE GUARD IS THE POINT. Between phase 1 and the phase-2 stamp the marker can be cleared
    // by a webhook that already landed, or re-armed for a LATER crossing. Stamping regardless
    // would label the new crossing with the old crossing's PaymentIntent, and the reconcile
    // would then read the WRONG charge's status to decide whether real money needs crediting.
    const { wallet } = await creditWalletFactory();
    const supersededEntryId = randomUUID();
    const currentEntryId = randomUUID();

    await creditWalletsRepository.armPendingTopup({
      walletId: wallet.id,
      at: new Date('2027-03-04T10:00:00.000Z'),
      triggeringEntryId: currentEntryId,
    });

    const stamped = await creditWalletsRepository.recordPendingTopupPaymentIntent({
      walletId: wallet.id,
      triggeringEntryId: supersededEntryId,
      paymentIntentId: 'pi_from_a_dead_crossing',
    });
    expect(stamped).toBe(false);

    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.pendingTopupPaymentIntentId).toBeNull();
    expect(persisted?.pendingTopupTriggeringEntryId).toBe(currentEntryId);
  });

  it('recordPendingTopupPaymentIntent returns FALSE when the marker was CLEARED (entry id now null)', async () => {
    const { wallet } = await creditWalletFactory();
    const triggeringEntryId = randomUUID();
    await creditWalletsRepository.armPendingTopup({
      walletId: wallet.id,
      at: new Date('2027-03-05T10:00:00.000Z'),
      triggeringEntryId,
    });
    await creditWalletsRepository.clearPendingTopup({ walletId: wallet.id });

    const stamped = await creditWalletsRepository.recordPendingTopupPaymentIntent({
      walletId: wallet.id,
      triggeringEntryId,
      paymentIntentId: 'pi_too_late',
    });
    expect(stamped).toBe(false);
    expect(
      (await creditWalletsRepository.findById(wallet.id))?.pendingTopupPaymentIntentId
    ).toBeNull();
  });

  it('clearPendingTopup nulls ALL THREE columns together', async () => {
    const { wallet } = await creditWalletFactory();
    const triggeringEntryId = randomUUID();
    await creditWalletsRepository.armPendingTopup({
      walletId: wallet.id,
      at: new Date('2027-03-06T10:00:00.000Z'),
      triggeringEntryId,
    });
    await creditWalletsRepository.recordPendingTopupPaymentIntent({
      walletId: wallet.id,
      triggeringEntryId,
      paymentIntentId: 'pi_to_be_cleared',
    });

    const clearedRow = await creditWalletsRepository.clearPendingTopup({ walletId: wallet.id });
    expect(clearedRow).toBe(true);

    const cleared = await creditWalletsRepository.findById(wallet.id);
    // A clear that left a stale entry id or PI id behind would hand the NEXT crossing's
    // reconcile evidence belonging to a resolved one.
    expect(cleared?.pendingTopupAt).toBeNull();
    expect(cleared?.pendingTopupTriggeringEntryId).toBeNull();
    expect(cleared?.pendingTopupPaymentIntentId).toBeNull();
  });

  it('clearPendingTopup composes under a caller transaction (the webhook passes its tx)', async () => {
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.armPendingTopup({
      walletId: wallet.id,
      at: new Date('2027-03-07T10:00:00.000Z'),
      triggeringEntryId: randomUUID(),
    });
    await db.transaction(async (tx) => {
      await creditWalletsRepository.clearPendingTopup({ walletId: wallet.id }, tx);
    });
    expect((await creditWalletsRepository.findById(wallet.id))?.pendingTopupAt).toBeNull();
  });

  it('clearPendingTopup GUARDED on the crossing writes NOTHING when the marker was re-armed for another one', async () => {
    // ⚠ THE EVIDENCE ERASURE THIS GUARD EXISTS FOR. The reconcile sweep reads up to 100 wallets
    // and then spends seconds of Stripe latency per row, so it acts on a stale snapshot; a Stripe
    // webhook can be redelivered for days. An unguarded clear from either would null the marker of
    // a LIVE, DIFFERENT crossing — and because the ledger idempotency key is PER CROSSING, the
    // next evaluation would then pin a new key, which the unique index cannot dedup: a second
    // real charge.
    const { wallet } = await creditWalletFactory();
    const supersededEntryId = randomUUID();
    const currentEntryId = randomUUID();
    const armedAt = new Date('2027-03-08T10:00:00.000Z');

    await creditWalletsRepository.armPendingTopup({
      walletId: wallet.id,
      at: armedAt,
      triggeringEntryId: currentEntryId,
    });
    await creditWalletsRepository.recordPendingTopupPaymentIntent({
      walletId: wallet.id,
      triggeringEntryId: currentEntryId,
      paymentIntentId: 'pi_live_crossing',
    });

    const cleared = await creditWalletsRepository.clearPendingTopup({
      walletId: wallet.id,
      triggeringEntryId: supersededEntryId,
    });

    expect(cleared).toBe(false);
    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.pendingTopupAt?.getTime()).toBe(armedAt.getTime());
    expect(persisted?.pendingTopupTriggeringEntryId).toBe(currentEntryId);
    expect(persisted?.pendingTopupPaymentIntentId).toBe('pi_live_crossing');
  });

  it('clearPendingTopup GUARDED clears all three columns when the crossing MATCHES', async () => {
    const { wallet } = await creditWalletFactory();
    const triggeringEntryId = randomUUID();
    await creditWalletsRepository.armPendingTopup({
      walletId: wallet.id,
      at: new Date('2027-03-09T10:00:00.000Z'),
      triggeringEntryId,
    });
    await creditWalletsRepository.recordPendingTopupPaymentIntent({
      walletId: wallet.id,
      triggeringEntryId,
      paymentIntentId: 'pi_matching',
    });

    const cleared = await creditWalletsRepository.clearPendingTopup({
      walletId: wallet.id,
      triggeringEntryId,
    });

    expect(cleared).toBe(true);
    const persisted = await creditWalletsRepository.findById(wallet.id);
    expect(persisted?.pendingTopupAt).toBeNull();
    expect(persisted?.pendingTopupTriggeringEntryId).toBeNull();
    expect(persisted?.pendingTopupPaymentIntentId).toBeNull();
  });

  it('armPendingTopup NULLS a stale alarm stamp — a TTL re-arm is a NEW crossing (BAL-521 D3)', async () => {
    // ⚠ THE MONEY BUG THE ROTATION WOULD OTHERWISE INTRODUCE. `pending_topup_alarmed_at` is the
    // finder's cursor: a stamped row sits behind every never-alarmed one. A legitimate TTL re-arm
    // that inherited the PREVIOUS crossing's stamp would push a NEW, LIVE, in-flight reload to
    // the back of every batch — silently, and for as long as it kept alarming, which is exactly
    // the starvation the rotation exists to end. A fresh crossing has never alarmed.
    const { wallet } = await creditWalletFactory();
    const firstEntryId = randomUUID();
    await creditWalletsRepository.armPendingTopup({
      walletId: wallet.id,
      at: new Date('2027-05-01T10:00:00.000Z'),
      triggeringEntryId: firstEntryId,
    });

    const stamped = await creditWalletsRepository.markPendingTopupAlarmed(
      [{ walletId: wallet.id, triggeringEntryId: firstEntryId }],
      new Date('2027-05-01T10:30:00.000Z')
    );
    expect(stamped).toBe(1);
    expect(
      (await creditWalletsRepository.findById(wallet.id))?.pendingTopupAlarmedAt
    ).toBeInstanceOf(Date);

    // The in-flight TTL lapses (a service decision — the repository's contract is simply "an arm
    // clears the stamp") and a LATER crossing re-arms the same wallet.
    await creditWalletsRepository.armPendingTopup({
      walletId: wallet.id,
      at: new Date('2027-05-01T11:00:00.000Z'),
      triggeringEntryId: randomUUID(),
    });

    expect((await creditWalletsRepository.findById(wallet.id))?.pendingTopupAlarmedAt).toBeNull();
  });

  it('clearPendingTopup nulls the alarm stamp along with the marker (BAL-521 D3)', async () => {
    // A drained marker has nothing left to be alarmed about, and the wallet is not a finder
    // candidate at all — leaving the stamp would make the cursor describe a crossing that no
    // longer exists.
    const { wallet } = await creditWalletFactory();
    const triggeringEntryId = randomUUID();
    await creditWalletsRepository.armPendingTopup({
      walletId: wallet.id,
      at: new Date('2027-05-02T10:00:00.000Z'),
      triggeringEntryId,
    });
    await creditWalletsRepository.markPendingTopupAlarmed(
      [{ walletId: wallet.id, triggeringEntryId }],
      new Date('2027-05-02T10:30:00.000Z')
    );

    expect(await creditWalletsRepository.clearPendingTopup({ walletId: wallet.id })).toBe(true);

    const cleared = await creditWalletsRepository.findById(wallet.id);
    expect(cleared?.pendingTopupAt).toBeNull();
    expect(cleared?.pendingTopupTriggeringEntryId).toBeNull();
    expect(cleared?.pendingTopupPaymentIntentId).toBeNull();
    expect(cleared?.pendingTopupAlarmedAt).toBeNull();
  });
});

describe('creditWalletsRepository.findStuckPendingTopups (BAL-515 reconcile finder)', () => {
  const CUTOFF = new Date('2027-04-01T12:00:00.000Z');

  /** Arm a fresh wallet's marker at `at`, optionally with no correlation (a pre-BAL-515 row). */
  async function armedWallet(at: Date, opts: { correlated?: boolean } = {}): Promise<string> {
    const { wallet } = await creditWalletFactory();
    if (opts.correlated === false) {
      // A marker with no triggering entry id — the shape every row carried before 0081. Written
      // raw because `armPendingTopup` cannot express it (and must not).
      await db.execute(
        sql`UPDATE credit_wallets SET pending_topup_at = ${at.toISOString()} WHERE id = ${wallet.id}`
      );
    } else {
      await creditWalletsRepository.armPendingTopup({
        walletId: wallet.id,
        at,
        triggeringEntryId: randomUUID(),
      });
    }
    return wallet.id;
  }

  it('returns markers at or before the cutoff, OLDEST first (within the never-alarmed group)', async () => {
    const newest = await armedWallet(new Date('2027-04-01T11:00:00.000Z'));
    const oldest = await armedWallet(new Date('2027-04-01T09:00:00.000Z'));
    const middle = await armedWallet(new Date('2027-04-01T10:00:00.000Z'));

    const found = await creditWalletsRepository.findStuckPendingTopups(CUTOFF, 10);
    // BAL-521: `pending_topup_at` is now the SECOND sort key, not the only one. No row here has
    // ever alarmed, so all three share a NULL cursor and this asserts the tie-break — the longest
    // -stuck money still drains first among rows of equal alarm standing.
    expect(ids(found)).toEqual([oldest, middle, newest]);
  });

  it('includes a marker exactly at the cutoff (inclusive `<=`) and excludes a younger one', async () => {
    const atCutoff = await armedWallet(CUTOFF);
    await armedWallet(new Date('2027-04-01T12:00:01.000Z')); // 1s too young

    const found = await creditWalletsRepository.findStuckPendingTopups(CUTOFF, 10);
    expect(ids(found)).toEqual([atCutoff]);
  });

  it('excludes wallets with NO marker and wallets whose marker carries no triggering entry id', async () => {
    // A marker with no correlation is unreconcilable — its ledger key is underivable — so
    // returning it would hand the sweep a row it could only skip, once a minute, forever. Such
    // rows are pre-BAL-515 leftovers and self-heal at TOPUP_IN_FLIGHT_TTL_MS.
    await creditWalletFactory(); // no marker at all
    await armedWallet(new Date('2027-04-01T09:00:00.000Z'), { correlated: false });
    const reconcilable = await armedWallet(new Date('2027-04-01T09:30:00.000Z'));

    const found = await creditWalletsRepository.findStuckPendingTopups(CUTOFF, 10);
    expect(ids(found)).toEqual([reconcilable]);
  });

  it('respects the limit, taking the OLDEST rows (the caller warns when the batch fills)', async () => {
    const oldest = await armedWallet(new Date('2027-04-01T08:00:00.000Z'));
    const second = await armedWallet(new Date('2027-04-01T09:00:00.000Z'));
    await armedWallet(new Date('2027-04-01T10:00:00.000Z'));

    const found = await creditWalletsRepository.findStuckPendingTopups(CUTOFF, 2);
    expect(ids(found)).toEqual([oldest, second]);
  });

  /**
   * BAL-521 §2 — the rotation. Seeds N stuck wallets in TWO statements (N companies, then N
   * wallets) instead of 2N factory round-trips: the starvation proof needs 102 rows and every
   * statement is paid for inside the per-test transaction. Each wallet is inserted already
   * carrying its marker, correlation and alarm stamp, so no follow-up UPDATE is needed.
   * `.returning()` preserves insert order, which is what makes the index zip valid.
   */
  async function seedStuckWallets(
    rows: ReadonlyArray<{ at: Date; alarmedAt: Date | null }>
  ): Promise<string[]> {
    const seededCompanies = await db
      .insert(companies)
      .values(rows.map((_, i) => ({ name: `Rotation Co ${i}`, isPersonal: false })))
      .returning({ id: companies.id });

    const walletValues = rows.map((row, i) => {
      const company = seededCompanies[i];
      // Guard, never `!` — `noUncheckedIndexedAccess` is on.
      if (company === undefined) {
        throw new Error('company bulk insert returned fewer rows than requested');
      }
      return {
        companyId: company.id,
        pendingTopupAt: row.at,
        pendingTopupTriggeringEntryId: randomUUID(),
        pendingTopupAlarmedAt: row.alarmedAt,
      };
    });

    const seededWallets = await db
      .insert(creditWallets)
      .values(walletValues)
      .returning({ id: creditWallets.id });
    return seededWallets.map((wallet) => wallet.id);
  }

  it('returns a NEVER-ALARMED row even behind 101 permanently-alarmed ones (BAL-521 §2)', async () => {
    // ⚠ THE STARVATION THIS WHOLE COLUMN EXISTS TO END. An alarming row writes nothing and clears
    // nothing BY DESIGN, so under the old single-key `pending_topup_at ASC` the same oldest
    // alarmed rows filled every 100-row batch forever and no newer stuck reload was ever
    // reconciled — silently, with no signal anywhere that it was happening. Here every alarmed
    // row is OLDER than the one fresh crossing, so by pending-age the fresh row is 102nd and a
    // batch of 100 would never reach it. A NULL cursor puts it first instead.
    const alarmedIds = await seedStuckWallets(
      Array.from({ length: 101 }, (_, i) => ({
        at: new Date(Date.UTC(2027, 3, 1, 0, 0, i)), // 00:00:00 … 00:01:40 — all long past
        alarmedAt: new Date(Date.UTC(2027, 3, 1, 6, 0, i)), // stamped in the same order
      }))
    );
    const [fresh] = await seedStuckWallets([
      { at: new Date('2027-04-01T11:59:00.000Z'), alarmedAt: null },
    ]);
    if (fresh === undefined) {
      throw new Error('fresh wallet seed failed');
    }

    const found = await creditWalletsRepository.findStuckPendingTopups(CUTOFF, 100);

    expect(found).toHaveLength(100);
    // The unstarvable head: never-alarmed leads, no matter how big the alarmed backlog is.
    expect(found[0]?.id).toBe(fresh);
    // …and the rest of the batch is the alarmed set, LEAST-RECENTLY-alarmed first.
    expect(ids(found).slice(1)).toEqual(alarmedIds.slice(0, 99));
  });

  it('rotates WITHIN the alarmed set — least-recently-alarmed first, not oldest-pending first', async () => {
    // A static "alarmed last, oldest-pending first" sort would re-check the same slice of the
    // alarmed set every tick and never reach the rest. Alarm order here is the REVERSE of pending
    // order, so only a cursor-led sort can produce the expected pair.
    const [alarmedFirst, alarmedSecond] = await seedStuckWallets([
      { at: new Date('2027-04-01T11:00:00.000Z'), alarmedAt: new Date('2027-04-01T08:00:00.000Z') },
      { at: new Date('2027-04-01T10:00:00.000Z'), alarmedAt: new Date('2027-04-01T09:00:00.000Z') },
      { at: new Date('2027-04-01T09:00:00.000Z'), alarmedAt: new Date('2027-04-01T10:00:00.000Z') },
    ]);

    const found = await creditWalletsRepository.findStuckPendingTopups(CUTOFF, 2);

    expect(ids(found)).toEqual([alarmedFirst, alarmedSecond]);
  });

  it('orders NULL cursors first, then alarmed rows, oldest-pending within each group', async () => {
    // The whole contract in one assertion: `pending_topup_alarmed_at ASC NULLS FIRST,
    // pending_topup_at ASC`. ⚠ `NULLS FIRST` is written explicitly in the query because
    // Postgres' ASC default is NULLS LAST — which would put every never-alarmed row at the BACK
    // and make the starvation strictly worse than it was before this change.
    const [neverB, neverA, alarmedEarly, alarmedLate] = await seedStuckWallets([
      { at: new Date('2027-04-01T10:30:00.000Z'), alarmedAt: null },
      { at: new Date('2027-04-01T09:30:00.000Z'), alarmedAt: null },
      { at: new Date('2027-04-01T08:00:00.000Z'), alarmedAt: new Date('2027-04-01T09:00:00.000Z') },
      { at: new Date('2027-04-01T07:00:00.000Z'), alarmedAt: new Date('2027-04-01T10:00:00.000Z') },
    ]);

    const found = await creditWalletsRepository.findStuckPendingTopups(CUTOFF, 10);

    expect(ids(found)).toEqual([neverA, neverB, alarmedEarly, alarmedLate]);
  });
});

describe('creditWalletsRepository.markPendingTopupAlarmed (BAL-521 §2 rotation stamp)', () => {
  /** A wallet with a live marker, returning the crossing the stamp must be guarded on. */
  async function armedCrossing(at: Date): Promise<{ walletId: string; triggeringEntryId: string }> {
    const { wallet } = await creditWalletFactory();
    const triggeringEntryId = randomUUID();
    await creditWalletsRepository.armPendingTopup({ walletId: wallet.id, at, triggeringEntryId });
    return { walletId: wallet.id, triggeringEntryId };
  }

  /** Count the write statements a call issues through the executor it was handed. */
  async function countingRun<T>(
    run: (exec: DbExecutor) => Promise<T>
  ): Promise<{ result: T; updates: number }> {
    return db.transaction(async (tx) => {
      let updates = 0;
      const counting: DbExecutor = new Proxy(tx, {
        get(target, prop, receiver): unknown {
          if (prop === 'update') {
            updates += 1;
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const result = await run(counting);
      return { result, updates };
    });
  }

  it('stamps EVERY row of the batch through ONE update statement (never one per row)', async () => {
    // The sweep can carry up to 100 rows per tick; one statement per row would be 100 extra
    // round-trips a minute on the money path. Counting statements through the supplied executor
    // is the only way this harness can prove "one", so the assertion is on the count, not on the
    // effect (which a per-row loop would also produce).
    const first = await armedCrossing(new Date('2027-06-01T09:00:00.000Z'));
    const second = await armedCrossing(new Date('2027-06-01T09:30:00.000Z'));
    const third = await armedCrossing(new Date('2027-06-01T10:00:00.000Z'));
    const at = new Date('2027-06-01T12:00:00.000Z');

    const { result: stamped, updates } = await countingRun((exec) =>
      creditWalletsRepository.markPendingTopupAlarmed([first, second, third], at, exec)
    );

    expect(stamped).toBe(3);
    expect(updates).toBe(1);
    for (const row of [first, second, third]) {
      const persisted = await creditWalletsRepository.findById(row.walletId);
      expect(persisted?.pendingTopupAlarmedAt?.getTime()).toBe(at.getTime());
    }
  });

  it('writes NOTHING for a crossing that was SUPERSEDED between the read and the stamp', async () => {
    // ⚠ THE GUARD IS THE POINT, and it is the SAME money hazard the `armPendingTopup` un-alarm
    // closes, arriving by a second route. The sweep reads up to 100 wallets and then spends
    // seconds of Stripe latency PER ROW before it stamps; in that window a marker can be re-armed
    // for a DIFFERENT, LIVE crossing. A bare `id IN (…)` stamp would de-prioritise that fresh
    // in-flight reload — permanently, and silently.
    const { walletId, triggeringEntryId: superseded } = await armedCrossing(
      new Date('2027-06-02T09:00:00.000Z')
    );
    const liveEntryId = randomUUID();
    await creditWalletsRepository.armPendingTopup({
      walletId,
      at: new Date('2027-06-02T09:45:00.000Z'),
      triggeringEntryId: liveEntryId,
    });

    const stamped = await creditWalletsRepository.markPendingTopupAlarmed(
      [{ walletId, triggeringEntryId: superseded }],
      new Date('2027-06-02T10:00:00.000Z')
    );

    expect(stamped).toBe(0);
    const persisted = await creditWalletsRepository.findById(walletId);
    expect(persisted?.pendingTopupAlarmedAt).toBeNull();
    expect(persisted?.pendingTopupTriggeringEntryId).toBe(liveEntryId);
  });

  it('stamps the still-current rows of a batch and skips the superseded one (partial landing)', async () => {
    // The shortfall is not an error — the caller warns on `stamped < batch.length` rather than
    // assuming the whole tick landed, which is only possible because the count is honest.
    const live = await armedCrossing(new Date('2027-06-03T09:00:00.000Z'));
    const { walletId: movedOn, triggeringEntryId: staleEntryId } = await armedCrossing(
      new Date('2027-06-03T09:10:00.000Z')
    );
    await creditWalletsRepository.armPendingTopup({
      walletId: movedOn,
      at: new Date('2027-06-03T09:50:00.000Z'),
      triggeringEntryId: randomUUID(),
    });
    const at = new Date('2027-06-03T10:00:00.000Z');

    const stamped = await creditWalletsRepository.markPendingTopupAlarmed(
      [live, { walletId: movedOn, triggeringEntryId: staleEntryId }],
      at
    );

    expect(stamped).toBe(1);
    expect((await creditWalletsRepository.findById(live.walletId))?.pendingTopupAlarmedAt).toEqual(
      at
    );
    expect((await creditWalletsRepository.findById(movedOn))?.pendingTopupAlarmedAt).toBeNull();
  });

  it('returns 0 and issues NO statement for an empty batch (an empty OR would stamp the world)', async () => {
    // `or()` over an empty list is `undefined`, and `.where(undefined)` is NO predicate — a bare
    // `.set()` across the whole table. The bystander below is what makes "the world" a real
    // assertion rather than a claim about the return value.
    const bystander = await armedCrossing(new Date('2027-06-04T09:00:00.000Z'));

    const { result: stamped, updates } = await countingRun((exec) =>
      creditWalletsRepository.markPendingTopupAlarmed(
        [],
        new Date('2027-06-04T10:00:00.000Z'),
        exec
      )
    );

    expect(stamped).toBe(0);
    expect(updates).toBe(0);
    expect(
      (await creditWalletsRepository.findById(bystander.walletId))?.pendingTopupAlarmedAt
    ).toBeNull();
  });

  it('RE-STAMPS an already-alarmed row — the column is LAST-alarmed-at, the rotation cursor', async () => {
    // If the stamp were written only once, the alarmed set would order by FIRST alarm forever and
    // the same rows would lead it every tick — starvation inside the alarmed set instead of
    // across it.
    const crossing = await armedCrossing(new Date('2027-06-05T09:00:00.000Z'));
    const firstAlarm = new Date('2027-06-05T10:00:00.000Z');
    const secondAlarm = new Date('2027-06-05T11:00:00.000Z');

    expect(await creditWalletsRepository.markPendingTopupAlarmed([crossing], firstAlarm)).toBe(1);
    expect(await creditWalletsRepository.markPendingTopupAlarmed([crossing], secondAlarm)).toBe(1);

    expect(
      (await creditWalletsRepository.findById(crossing.walletId))?.pendingTopupAlarmedAt?.getTime()
    ).toBe(secondAlarm.getTime());
  });
});

describe('creditWalletsRepository.countAlarmedPendingTopups (BAL-521 §2 backlog size)', () => {
  const CUTOFF = new Date('2027-07-01T12:00:00.000Z');

  /** A wallet whose marker columns are written directly — the count is a pure read. */
  async function walletWith(values: {
    pendingTopupAt: Date | null;
    pendingTopupTriggeringEntryId: string | null;
    pendingTopupAlarmedAt: Date | null;
  }): Promise<string> {
    const { wallet } = await creditWalletFactory({ values });
    return wallet.id;
  }

  it('counts stuck AND alarmed rows past the cutoff — and nothing else', async () => {
    // ⚠ NOT DERIVABLE FROM WHAT A TICK REPORTS. Alarmed rows rotate, so one tick reaches only a
    // slice of the backlog; without this figure a filled batch of 100 is indistinguishable from a
    // backlog of 10,000. It shares its three stuck arms with the finder, so the count can never
    // describe a different row set than the thing it is sizing.
    const stuckAt = new Date('2027-07-01T09:00:00.000Z');
    await walletWith({
      pendingTopupAt: stuckAt,
      pendingTopupTriggeringEntryId: randomUUID(),
      pendingTopupAlarmedAt: new Date('2027-07-01T10:00:00.000Z'),
    });
    await walletWith({
      pendingTopupAt: stuckAt,
      pendingTopupTriggeringEntryId: randomUUID(),
      pendingTopupAlarmedAt: new Date('2027-07-01T11:00:00.000Z'),
    });
    // Stuck, but never alarmed — a candidate, not a backlog item.
    await walletWith({
      pendingTopupAt: stuckAt,
      pendingTopupTriggeringEntryId: randomUUID(),
      pendingTopupAlarmedAt: null,
    });
    // Alarmed once, but its CURRENT marker is younger than the cutoff — not yet stuck again.
    await walletWith({
      pendingTopupAt: new Date('2027-07-01T12:00:01.000Z'),
      pendingTopupTriggeringEntryId: randomUUID(),
      pendingTopupAlarmedAt: new Date('2027-07-01T11:30:00.000Z'),
    });
    // Alarmed, stuck, but UNCORRELATED — unreconcilable, so the finder never returns it and the
    // backlog must not claim it either.
    await walletWith({
      pendingTopupAt: stuckAt,
      pendingTopupTriggeringEntryId: null,
      pendingTopupAlarmedAt: new Date('2027-07-01T11:00:00.000Z'),
    });
    // No marker at all.
    await creditWalletFactory();

    expect(await creditWalletsRepository.countAlarmedPendingTopups(CUTOFF)).toBe(2);
  });

  it('counts a marker exactly AT the cutoff (the same inclusive `<=` the finder uses)', async () => {
    await walletWith({
      pendingTopupAt: CUTOFF,
      pendingTopupTriggeringEntryId: randomUUID(),
      pendingTopupAlarmedAt: new Date('2027-07-01T12:30:00.000Z'),
    });

    expect(await creditWalletsRepository.countAlarmedPendingTopups(CUTOFF)).toBe(1);
  });

  it('returns 0 when nothing has alarmed (a tick with an empty backlog reports a real zero)', async () => {
    await walletWith({
      pendingTopupAt: new Date('2027-07-01T09:00:00.000Z'),
      pendingTopupTriggeringEntryId: randomUUID(),
      pendingTopupAlarmedAt: null,
    });

    expect(await creditWalletsRepository.countAlarmedPendingTopups(CUTOFF)).toBe(0);
  });
});

describe('creditWalletsRepository.listByStripePaymentMethodId (BAL-515 payment_method.* arms)', () => {
  it('returns the single wallet holding the payment method', async () => {
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.applySavedCardDisplay(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_pm_1',
      stripePaymentMethodId: 'pm_lookup_1',
      card: { cardBrand: 'visa', cardLast4: '4242', cardExpMonth: 8, cardExpYear: 2028 },
    });
    await creditWalletFactory(); // a decoy wallet with no card

    const found = await creditWalletsRepository.listByStripePaymentMethodId('pm_lookup_1');
    expect(ids(found)).toEqual([wallet.id]);
  });

  it('returns an EMPTY array when no wallet holds the payment method (the arm acks 200 and does nothing)', async () => {
    await creditWalletFactory();
    const found = await creditWalletsRepository.listByStripePaymentMethodId('pm_nobody_holds');
    expect(found).toEqual([]);
  });

  it('returns BOTH wallets when two hold the same payment method (ambiguity is reported, not resolved)', async () => {
    // No constraint forbids this, which is exactly why the supporting index is NON-unique: a
    // UNIQUE index would have aborted migration 0081 on any pre-existing duplicate, and the
    // empty-database harness could not have surfaced that. The repository therefore surfaces the
    // ambiguity and the caller refuses to act on a card event it cannot attribute.
    const first = await creditWalletFactory();
    const second = await creditWalletFactory();
    for (const seeded of [first, second]) {
      await creditWalletsRepository.applySavedCardDisplay(db, {
        walletId: seeded.wallet.id,
        stripeCustomerId: 'cus_shared',
        stripePaymentMethodId: 'pm_shared_1',
        card: { cardBrand: 'visa', cardLast4: '4242', cardExpMonth: 8, cardExpYear: 2028 },
      });
    }

    const found = await creditWalletsRepository.listByStripePaymentMethodId('pm_shared_1');
    expect(found).toHaveLength(2);
    expect(ids(found).sort()).toEqual([first.wallet.id, second.wallet.id].sort());
  });
});

describe('creditWalletsRepository card provenance + refresh/clear (BAL-515)', () => {
  const CARD = { cardBrand: 'visa', cardLast4: '4242', cardExpMonth: 8, cardExpYear: 2028 };

  it('applySavedCardDisplay stamps card_updated_at alongside the four display columns', async () => {
    const { wallet } = await creditWalletFactory();
    expect(wallet.cardUpdatedAt).toBeNull();

    const updated = await creditWalletsRepository.applySavedCardDisplay(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_prov_1',
      stripePaymentMethodId: 'pm_prov_1',
      card: CARD,
    });

    expect(updated.cardUpdatedAt).toBeInstanceOf(Date);
    expect(updated.cardLast4).toBe('4242');
  });

  it('applyMandate WITH a card stamps card_updated_at; WITHOUT a card leaves it untouched', async () => {
    // The asymmetry is the contract: a card-less mandate write must not claim the displayed card
    // was refreshed, because nothing read it (Stripe failed soft).
    const { wallet } = await creditWalletFactory();

    const withoutCard = await creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_m_1',
      stripePaymentMethodId: 'pm_m_1',
      mandateRef: 'seti_m_1',
      mandateStatus: 'active',
    });
    expect(withoutCard.cardUpdatedAt).toBeNull();
    expect(withoutCard.cardBrand).toBeNull();

    const withCard = await creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_m_1',
      stripePaymentMethodId: 'pm_m_1',
      mandateRef: 'seti_m_2',
      mandateStatus: 'active',
      card: CARD,
    });
    expect(withCard.cardUpdatedAt).toBeInstanceOf(Date);
  });

  it('refreshSavedCardDisplay rewrites the four display columns + provenance and TOUCHES NOTHING ELSE', async () => {
    // ⚠ The narrowness is the whole point. `payment_method.automatically_updated` carries the
    // SAME payment-method id — the network reissued the card behind it — so there is no consent
    // event. Routing this through `applySavedCardDisplay` would drag its mandate-revoke branch
    // onto a pure display refresh, where an issuer reissuing a card would silently disable the
    // buyer's auto-top-up.
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_refresh',
      stripePaymentMethodId: 'pm_refresh',
      mandateRef: 'seti_refresh',
      mandateStatus: 'active',
      card: CARD,
    });

    const refreshed = await creditWalletsRepository.refreshSavedCardDisplay(db, {
      walletId: wallet.id,
      card: { cardBrand: 'visa', cardLast4: '1881', cardExpMonth: 11, cardExpYear: 2031 },
    });

    expect(refreshed.cardBrand).toBe('visa');
    expect(refreshed.cardLast4).toBe('1881');
    expect(refreshed.cardExpMonth).toBe(11);
    expect(refreshed.cardExpYear).toBe(2031);
    expect(refreshed.cardUpdatedAt).toBeInstanceOf(Date);
    // Untouched: the mandate survives an issuer reissue.
    expect(refreshed.stripePaymentMethodId).toBe('pm_refresh');
    expect(refreshed.mandateRef).toBe('seti_refresh');
    expect(refreshed.mandateStatus).toBe('active');
    expect(refreshed.stripeCustomerId).toBe('cus_refresh');
    expect(isWalletMandateActive(refreshed)).toBe(true);
  });

  it('refreshSavedCardDisplay throws for an unknown wallet id', async () => {
    await expect(
      creditWalletsRepository.refreshSavedCardDisplay(db, {
        walletId: '00000000-0000-0000-0000-000000000000',
        card: CARD,
      })
    ).rejects.toThrow('Credit wallet not found');
  });

  it('clearSavedCard nulls the four display columns + the payment method + the mandate, KEEPS the customer', async () => {
    // Fail-closed: a detached payment method cannot be charged, so leaving `mandate_status`
    // active would let auto-top-up and overdraft settlement keep firing off-session charges at a
    // dead card. The Stripe CUSTOMER outlives the detach — blanking it would make
    // `ensureCustomer` mint a duplicate and split the company's payment history in two.
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_detach',
      stripePaymentMethodId: 'pm_detach',
      mandateRef: 'seti_detach',
      mandateStatus: 'active',
      card: CARD,
    });

    const cleared = await creditWalletsRepository.clearSavedCard(db, wallet.id);

    expect(cleared.cardBrand).toBeNull();
    expect(cleared.cardLast4).toBeNull();
    expect(cleared.cardExpMonth).toBeNull();
    expect(cleared.cardExpYear).toBeNull();
    expect(cleared.stripePaymentMethodId).toBeNull();
    expect(cleared.mandateRef).toBeNull();
    expect(cleared.mandateStatus).toBeNull();
    expect(cleared.stripeCustomerId).toBe('cus_detach');
    // "We learned at this time that there is no card" is provenance too.
    expect(cleared.cardUpdatedAt).toBeInstanceOf(Date);
    // Both consent predicates now refuse — nothing may be charged against a detached card.
    expect(isWalletMandateActive(cleared)).toBe(false);
    expect(isWalletCardReusableOnSession(cleared)).toBe(false);
  });

  it('clearSavedCard satisfies the all-or-none CHECK by clearing the four TOGETHER (one statement)', async () => {
    // If the four were cleared in separate statements the CHECK would fire on the first; that it
    // commits is the proof they move together. Re-read from the DB, not the RETURNING row.
    const { wallet } = await creditWalletFactory();
    await creditWalletsRepository.applySavedCardDisplay(db, {
      walletId: wallet.id,
      stripeCustomerId: 'cus_check',
      stripePaymentMethodId: 'pm_check',
      card: CARD,
    });

    await creditWalletsRepository.clearSavedCard(db, wallet.id);

    const rows = await db.select().from(creditWallets).where(eq(creditWallets.id, wallet.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cardBrand).toBeNull();
    expect(rows[0]?.cardExpYear).toBeNull();
  });

  it('clearSavedCard composes under a caller transaction and throws for an unknown wallet id', async () => {
    const { wallet } = await creditWalletFactory();
    await db.transaction(async (tx) => {
      await creditWalletsRepository.clearSavedCard(tx, wallet.id);
    });
    expect((await creditWalletsRepository.findById(wallet.id))?.stripePaymentMethodId).toBeNull();

    await expect(
      creditWalletsRepository.clearSavedCard(db, '00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow('Credit wallet not found');
  });
});

describe('creditWalletsRepository.clearSavedCardAndReconcileMode (BAL-516 / BAL-521)', () => {
  const CARD = { cardBrand: 'amex', cardLast4: '0005', cardExpMonth: 4, cardExpYear: 2030 };

  /**
   * BAL-521 generalised the primitive from a bare `actorUserId: string` to
   * `{ actorUserId, source }`, so BOTH doors write one shared `credit_wallet.saved_card_detached`
   * row. Every pre-existing case below moved to this helper with its INTENT UNCHANGED — the user
   * door is still a real member acting, and the audit metadata it produces is still
   * `source: 'user_initiated'`. The webhook door is exercised separately.
   */
  const USER_DOOR = (actorUserId: string): { actorUserId: string; source: 'user_initiated' } => ({
    actorUserId,
    source: 'user_initiated',
  });

  /**
   * ⚠ DELIBERATELY NOT THE SCHEMA DEFAULTS (threshold 2000 / reload 10_000). The promise under
   * test is that the client's CHOSEN band survives a card removal, so asserting the defaults
   * afterwards would pass whether the figures were preserved or reset — proving nothing.
   */
  const BAND = { topupThresholdMinor: 7_500, topupReloadMinor: 42_500 };

  /** A wallet on `mode` with a live card + active mandate and the non-default band above. */
  async function seedCardBackedWallet(mode: CreditWallet['lowBalanceMode']): Promise<CreditWallet> {
    const { wallet } = await creditWalletFactory({ values: { lowBalanceMode: mode, ...BAND } });
    return creditWalletsRepository.applyMandate(db, {
      walletId: wallet.id,
      stripeCustomerId: `cus_rm_${mode}`,
      stripePaymentMethodId: `pm_rm_${mode}`,
      mandateRef: `seti_rm_${mode}`,
      mandateStatus: 'active',
      card: CARD,
    });
  }

  it('auto_topup: clears the card AND disarms the mode, keeping the customer and the band', async () => {
    // The whole point of the pairing: a wallet cannot be left holding no card while still
    // naming a card-backed mode, or auto-top-up keeps firing off-session charges at nothing.
    const seeded = await seedCardBackedWallet('auto_topup');
    expect(seeded.topupReloadMinor).toBe(42_500); // the seed really took (band is non-default)
    const actor = await userFactory();

    const { wallet, modeReconciled } = await db.transaction((tx) =>
      creditWalletsRepository.clearSavedCardAndReconcileMode(tx, seeded.id, USER_DOOR(actor.id))
    );

    expect(modeReconciled).toBe(true);
    expect(wallet.lowBalanceMode).toBe('notify_only');
    // The delegation to `clearSavedCard` is asserted on the COLUMNS, not taken on trust.
    expect(wallet.cardBrand).toBeNull();
    expect(wallet.cardLast4).toBeNull();
    expect(wallet.cardExpMonth).toBeNull();
    expect(wallet.cardExpYear).toBeNull();
    expect(wallet.stripePaymentMethodId).toBeNull();
    expect(wallet.mandateRef).toBeNull();
    expect(wallet.mandateStatus).toBeNull();
    expect(wallet.cardUpdatedAt).toBeInstanceOf(Date);
    // The Stripe CUSTOMER survives — blanking it would mint a duplicate customer next time.
    expect(wallet.stripeCustomerId).toBe('cus_rm_auto_topup');
    expect(isWalletMandateActive(wallet)).toBe(false);
    expect(isWalletCardReusableOnSession(wallet)).toBe(false);
    // The band survives verbatim, so re-enabling auto top-up later restores the client's choice.
    expect(wallet.topupThresholdMinor).toBe(7_500);
    expect(wallet.topupReloadMinor).toBe(42_500);

    // Persisted, not merely RETURNING-ed.
    const persisted = await creditWalletsRepository.findById(seeded.id);
    expect(persisted?.lowBalanceMode).toBe('notify_only');
    expect(persisted?.stripePaymentMethodId).toBeNull();
    expect(persisted?.cardLast4).toBeNull();
    expect(persisted?.stripeCustomerId).toBe('cus_rm_auto_topup');
    expect(persisted?.topupThresholdMinor).toBe(7_500);
    expect(persisted?.topupReloadMinor).toBe(42_500);
  });

  it('keep_going: the other card-backed mode reconciles identically', async () => {
    const seeded = await seedCardBackedWallet('keep_going');
    const actor = await userFactory();

    const { wallet, modeReconciled } = await db.transaction((tx) =>
      creditWalletsRepository.clearSavedCardAndReconcileMode(tx, seeded.id, USER_DOOR(actor.id))
    );

    expect(modeReconciled).toBe(true);
    expect(wallet.lowBalanceMode).toBe('notify_only');
    expect(wallet.stripePaymentMethodId).toBeNull();
    expect(wallet.mandateStatus).toBeNull();
    expect(wallet.stripeCustomerId).toBe('cus_rm_keep_going');
    expect(wallet.topupThresholdMinor).toBe(7_500);
    expect(wallet.topupReloadMinor).toBe(42_500);
  });

  it('notify_only: clears the card and LEAVES the mode alone (modeReconciled false)', async () => {
    // Nothing is armed, so there is nothing to disarm — the UPDATE must not run at all.
    const seeded = await seedCardBackedWallet('notify_only');
    const actor = await userFactory();

    const { wallet, modeReconciled } = await db.transaction((tx) =>
      creditWalletsRepository.clearSavedCardAndReconcileMode(tx, seeded.id, USER_DOOR(actor.id))
    );

    expect(modeReconciled).toBe(false);
    expect(wallet.lowBalanceMode).toBe('notify_only');
    // The clear still happened — this arm returns the CLEARED row, never the pre-clear one.
    expect(wallet.cardBrand).toBeNull();
    expect(wallet.cardLast4).toBeNull();
    expect(wallet.cardExpMonth).toBeNull();
    expect(wallet.cardExpYear).toBeNull();
    expect(wallet.stripePaymentMethodId).toBeNull();
    expect(wallet.mandateRef).toBeNull();
    expect(wallet.mandateStatus).toBeNull();
    expect(wallet.stripeCustomerId).toBe('cus_rm_notify_only');
    expect(wallet.topupThresholdMinor).toBe(7_500);
    expect(wallet.topupReloadMinor).toBe(42_500);
  });

  it('converges on a wallet that never held a card — no throw, nothing reconciled', async () => {
    // The repeat-call / no-stored-card path: the caller skips Stripe entirely but still runs
    // this transaction, so it must be a clean no-op rather than an error.
    const { wallet: fresh } = await creditWalletFactory({ values: BAND });
    expect(fresh.lowBalanceMode).toBe('notify_only');
    const actor = await userFactory();

    const { wallet, modeReconciled } = await db.transaction((tx) =>
      creditWalletsRepository.clearSavedCardAndReconcileMode(tx, fresh.id, USER_DOOR(actor.id))
    );

    expect(modeReconciled).toBe(false);
    expect(wallet.lowBalanceMode).toBe('notify_only');
    expect(wallet.stripePaymentMethodId).toBeNull();
    expect(wallet.stripeCustomerId).toBeNull();
    expect(wallet.topupThresholdMinor).toBe(7_500);
    expect(wallet.topupReloadMinor).toBe(42_500);
  });

  it('disarms a card-backed mode even when the card is ALREADY gone (webhook won the race)', async () => {
    // `payment_method.detached` can land before the user-initiated removal reaches us: the
    // webhook's `clearSavedCard` does NOT reconcile the mode, so this call arrives at a wallet
    // with no card but auto-top-up still armed. The reconcile is driven by the MODE, not by
    // whether a card was found — that is what upholds "no card ⇒ no card-backed mode armed".
    const seeded = await seedCardBackedWallet('auto_topup');
    await creditWalletsRepository.clearSavedCard(db, seeded.id);
    const actor = await userFactory();

    const { wallet, modeReconciled } = await db.transaction((tx) =>
      creditWalletsRepository.clearSavedCardAndReconcileMode(tx, seeded.id, USER_DOOR(actor.id))
    );

    expect(modeReconciled).toBe(true);
    expect(wallet.lowBalanceMode).toBe('notify_only');
    expect(wallet.stripePaymentMethodId).toBeNull();
  });

  it('issues ALL writes through the CALLER-SUPPLIED executor, never the base `db`', async () => {
    // ⚠ THE ATOMICITY GUARANTEE, PROVED THE ONLY WAY THIS HARNESS CAN PROVE IT. The function
    // does not self-transact — the caller's transaction is what keeps card-gone/mode-still-armed
    // (and now the audit row) unobservable — so a write that escaped to the base `db` would
    // break the guarantee.
    //
    // A rollback proof CANNOT catch that here, and this test is written this way because the
    // rollback form was tried and mutation-tested first: every client in this harness shares ONE
    // connection inside ONE per-test transaction (max:1 pool), so an escaped write is undone by
    // the very same SAVEPOINT and the caller-aborts assertion passes even when the reconcile is
    // hard-coded to `db`. Counting the statements issued through the supplied executor is what
    // actually fails on that mutation.
    const seeded = await seedCardBackedWallet('auto_topup');
    const actor = await userFactory();

    const writesOnCallerTx = await db.transaction(async (tx) => {
      let updates = 0;
      let inserts = 0;
      const counting: DbExecutor = new Proxy(tx, {
        get(target, prop, receiver): unknown {
          if (prop === 'update') {
            updates += 1;
          }
          if (prop === 'insert') {
            inserts += 1;
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const { modeReconciled } = await creditWalletsRepository.clearSavedCardAndReconcileMode(
        counting,
        seeded.id,
        USER_DOOR(actor.id)
      );
      expect(modeReconciled).toBe(true);
      return { updates, inserts };
    });

    // Exactly two updates (`clearSavedCard`'s one-statement clear, then the mode reconcile) plus
    // ONE insert — the audit row (FIX ROUND 3 N2).
    expect(writesOnCallerTx).toEqual({ updates: 2, inserts: 1 });
    expect((await creditWalletsRepository.findById(seeded.id))?.lowBalanceMode).toBe('notify_only');
  });

  it('appends ONE audit_events row naming the actor, in the SAME transaction as the clear (FIX ROUND 3 N2)', async () => {
    const seeded = await seedCardBackedWallet('auto_topup');
    const actor = await userFactory();

    const { modeReconciled } = await db.transaction((tx) =>
      creditWalletsRepository.clearSavedCardAndReconcileMode(tx, seeded.id, USER_DOOR(actor.id))
    );
    expect(modeReconciled).toBe(true);

    const rows = await db.select().from(auditEvents).where(eq(auditEvents.entityId, seeded.id));
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.actorUserId).toBe(actor.id);
    // `<entityType>.<verb>`, matching the sibling `credit_wallet.dispute_opened`. BAL-521 §3's
    // inbound webhook detach must write this SAME action with `source: 'stripe_webhook'`, so one
    // query answers "how did this wallet lose its card?" — hence the shared name + `source`
    // discriminator rather than two action strings.
    expect(row?.action).toBe('credit_wallet.saved_card_detached');
    expect(row?.entityType).toBe('credit_wallet');
    // The source, the effective mode, and whether it was reconciled — NEVER card facts, a
    // `mandateRef`, or any Stripe id.
    expect(row?.metadata).toEqual({
      source: 'user_initiated',
      modeReconciled: true,
      lowBalanceMode: 'notify_only',
    });
  });

  it('a failed audit write rolls the clear back too — fail-closed (FIX ROUND 3 N2)', async () => {
    // No `userFactory()` row exists for this id, so the audit insert trips the
    // `audit_events.actor_user_id → users.id` FK — proving the audit write is NOT best-effort:
    // it is the LAST statement in the transaction, so its failure must undo the clear + reconcile
    // that already ran ahead of it.
    //
    // ⚠ BAL-521: DO NOT "MODERNISE" THIS TO `actorUserId: null`. `null` is the legal system-actor
    // value the webhook door uses; it inserts cleanly, the FK never fires, and this test would go
    // silently green while testing nothing. A BOGUS NON-NULL actor is what makes it a test.
    const seeded = await seedCardBackedWallet('auto_topup');
    const unknownActorId = '00000000-0000-0000-0000-000000000000';

    await expect(
      db.transaction((tx) =>
        creditWalletsRepository.clearSavedCardAndReconcileMode(
          tx,
          seeded.id,
          USER_DOOR(unknownActorId)
        )
      )
    ).rejects.toThrow();

    const persisted = await creditWalletsRepository.findById(seeded.id);
    expect(persisted?.lowBalanceMode).toBe('auto_topup');
    expect(persisted?.stripePaymentMethodId).toBe('pm_rm_auto_topup');
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.entityId, seeded.id));
    expect(rows).toHaveLength(0);
  });

  it('throws for an unknown wallet id', async () => {
    const actor = await userFactory();
    await expect(
      db.transaction((tx) =>
        creditWalletsRepository.clearSavedCardAndReconcileMode(
          tx,
          '00000000-0000-0000-0000-000000000000',
          USER_DOOR(actor.id)
        )
      )
    ).rejects.toThrow('Credit wallet not found');
  });

  it('the WEBHOOK door writes the SAME action with a NULL actor and source stripe_webhook (BAL-521 §3)', async () => {
    // ⚠ ONE ACTION, TWO DOORS. `payment_method.detached` (the bank, the card provider, or a
    // Dashboard action) has no human actor at all, so `actorUserId: null` — the repo's shipped
    // system-actor convention, which inserts cleanly against the nullable
    // `audit_events.actor_user_id` and needs no sentinel user. What tells the doors apart is
    // `metadata.source`, NEVER a forked action name, so ONE query answers "how did this wallet
    // lose its card?".
    const seeded = await seedCardBackedWallet('keep_going');

    const { modeReconciled } = await db.transaction((tx) =>
      creditWalletsRepository.clearSavedCardAndReconcileMode(tx, seeded.id, {
        actorUserId: null,
        source: 'stripe_webhook',
      })
    );

    // The webhook door reconciles the mode exactly like the user door: no card ⇒ no card-backed
    // mode armed, whichever way the card left.
    expect(modeReconciled).toBe(true);
    expect((await creditWalletsRepository.findById(seeded.id))?.lowBalanceMode).toBe('notify_only');

    const rows = await db.select().from(auditEvents).where(eq(auditEvents.entityId, seeded.id));
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.actorUserId).toBeNull();
    expect(row?.action).toBe('credit_wallet.saved_card_detached');
    expect(row?.entityType).toBe('credit_wallet');
    expect(row?.metadata).toEqual({
      source: 'stripe_webhook',
      modeReconciled: true,
      lowBalanceMode: 'notify_only',
    });
  });

  it('returns the audit row id and the PRE-reconcile mode (BAL-521 D8)', async () => {
    // `auditEventId` — the id the primitive used to discard. The user door's notification
    // correlationId is built from it, so it has to come back out.
    // `previousLowBalanceMode` — the returned wallet is ALWAYS `notify_only` once reconciled, so
    // the row can no longer say WHICH card-backed mode went off, and the copy has to name it.
    const seeded = await seedCardBackedWallet('auto_topup');
    const actor = await userFactory();

    const { auditEventId, previousLowBalanceMode, wallet, modeReconciled } = await db.transaction(
      (tx) =>
        creditWalletsRepository.clearSavedCardAndReconcileMode(tx, seeded.id, USER_DOOR(actor.id))
    );

    expect(modeReconciled).toBe(true);
    expect(previousLowBalanceMode).toBe('auto_topup');
    // Not merely "a truthy string" — it is the id of the row that was actually inserted.
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.entityId, seeded.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(auditEventId);
    // The effective mode on the returned row is the RECONCILED one — the two are different facts,
    // which is exactly why both are surfaced.
    expect(wallet.lowBalanceMode).toBe('notify_only');
  });

  it('previousLowBalanceMode reports notify_only when nothing was armed (no false claim to make)', async () => {
    // The consequence copy branches on `modeReconciled`; this arm has nothing to name as "now
    // off". Pinning it stops a future reader inferring that the field only ever carries a
    // card-backed mode.
    const seeded = await seedCardBackedWallet('notify_only');
    const actor = await userFactory();

    const { previousLowBalanceMode, modeReconciled } = await db.transaction((tx) =>
      creditWalletsRepository.clearSavedCardAndReconcileMode(tx, seeded.id, USER_DOOR(actor.id))
    );

    expect(modeReconciled).toBe(false);
    expect(previousLowBalanceMode).toBe('notify_only');
  });
});
