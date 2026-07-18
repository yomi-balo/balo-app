import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { promoRedemptions } from '../schema';
import {
  companyFactory,
  creditWalletFactory,
  promoCodeFactory,
  promoRedemptionFactory,
  userFactory,
} from '../test/factories';
import {
  promoRedemptionsRepository,
  PromoInvalidError,
  PromoScheduledError,
  PromoExpiredError,
  PromoExhaustedError,
} from './promo-redemptions';
import { promoCodesRepository } from './promo-codes';
import { creditWalletsRepository } from './credit-wallets';
import { creditLedgerRepository } from './credit-ledger';
import { deriveIdempotencyKey } from './_shared/credit-idempotency';

/**
 * Integration tests for the promo redeem engine (BAL-377 / ADR-1040 Lane 1). Covers:
 *  - `validate` for each discriminated reason (invalid / scheduled / expired / exhausted /
 *    already_used) + the ok path.
 *  - `redeem` happy path — a `reason='promo', entry_type='adjustment'` ledger row, a
 *    `promo_redemptions` row, `redeemed_count + 1`, and the wallet's `expires_at` rolled
 *    forward (proves the rolling-expiry clock applies to promo grants).
 *  - single-use per company (2nd redeem → `already_redeemed`, count NOT double-incremented,
 *    the new `(promo_code_id, company_id)` unique enforced at the DB).
 *  - idempotent replay — a repeat redeem and a bare ledger-key replay both no-op (no double
 *    grant, no double count).
 *  - the redeem error branches (invalid / scheduled / expired) + deterministic cap
 *    exhaustion across companies under the row lock.
 *
 * Factory-seeded; the per-test transaction auto-rolls-back. `redeem` is tx-composable, so
 * each call is wrapped in `db.transaction(...)` (a SAVEPOINT under the harness) exactly as
 * the api webhook will call it inside its own transaction.
 */

const NOW = new Date('2026-06-01T00:00:00.000Z');
const IN_WINDOW = {
  validFrom: new Date('2026-01-01T00:00:00.000Z'),
  validUntil: new Date('2026-12-31T00:00:00.000Z'),
};

/** Wrap the tx-composable redeem in a transaction (SAVEPOINT under the test harness). */
function redeem(input: Parameters<typeof promoRedemptionsRepository.redeem>[1]) {
  return db.transaction((tx) => promoRedemptionsRepository.redeem(tx, input));
}

describe('promoRedemptionsRepository.validate', () => {
  it('ok: returns the promoCodeId + grant for a fresh, in-window, un-redeemed code', async () => {
    const code = await promoCodeFactory({
      values: { code: 'OKCODE', grantMinor: 5000, perCodeRedemptionCap: 100, ...IN_WINDOW },
    });
    const company = await companyFactory();

    const result = await promoRedemptionsRepository.validate({
      code: 'okcode', // case-insensitive (normalised)
      companyId: company.id,
      now: NOW,
    });

    expect(result).toEqual({ ok: true, promoCodeId: code.id, grantMinor: 5000 });
  });

  it('invalid: unknown / soft-deleted / deactivated code', async () => {
    const company = await companyFactory();

    // Unknown.
    expect(
      await promoRedemptionsRepository.validate({ code: 'NOPE', companyId: company.id, now: NOW })
    ).toEqual({ ok: false, reason: 'invalid' });

    // Soft-deleted.
    await promoCodeFactory({ values: { code: 'GONE', deletedAt: new Date(), ...IN_WINDOW } });
    expect(
      await promoRedemptionsRepository.validate({ code: 'GONE', companyId: company.id, now: NOW })
    ).toEqual({ ok: false, reason: 'invalid' });

    // Deactivated.
    await promoCodeFactory({ values: { code: 'OFF', status: 'deactivated', ...IN_WINDOW } });
    expect(
      await promoRedemptionsRepository.validate({ code: 'OFF', companyId: company.id, now: NOW })
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('scheduled: now is before valid_from', async () => {
    await promoCodeFactory({
      values: {
        code: 'FUTURE',
        validFrom: new Date('2027-01-01T00:00:00.000Z'),
        validUntil: new Date('2027-12-31T00:00:00.000Z'),
      },
    });
    const company = await companyFactory();

    expect(
      await promoRedemptionsRepository.validate({ code: 'FUTURE', companyId: company.id, now: NOW })
    ).toEqual({ ok: false, reason: 'scheduled' });
  });

  it('expired: now is after valid_until', async () => {
    await promoCodeFactory({
      values: {
        code: 'PAST',
        validFrom: new Date('2025-01-01T00:00:00.000Z'),
        validUntil: new Date('2025-12-31T00:00:00.000Z'),
      },
    });
    const company = await companyFactory();

    expect(
      await promoRedemptionsRepository.validate({ code: 'PAST', companyId: company.id, now: NOW })
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('exhausted: redeemed_count has reached the cap', async () => {
    await promoCodeFactory({
      values: { code: 'MAXED', perCodeRedemptionCap: 5, redeemedCount: 5, ...IN_WINDOW },
    });
    const company = await companyFactory();

    expect(
      await promoRedemptionsRepository.validate({ code: 'MAXED', companyId: company.id, now: NOW })
    ).toEqual({ ok: false, reason: 'exhausted' });
  });

  it('already_used: a redemption already exists for this company', async () => {
    const code = await promoCodeFactory({
      values: { code: 'ONCE', perCodeRedemptionCap: 100, ...IN_WINDOW },
    });
    const company = await companyFactory();
    await promoRedemptionFactory({ promoCodeId: code.id, companyId: company.id });

    expect(
      await promoRedemptionsRepository.validate({ code: 'ONCE', companyId: company.id, now: NOW })
    ).toEqual({ ok: false, reason: 'already_used' });

    // A DIFFERENT company may still redeem (single-use is per-company).
    const other = await companyFactory();
    const result = await promoRedemptionsRepository.validate({
      code: 'ONCE',
      companyId: other.id,
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });
});

describe('promoRedemptionsRepository.redeem — happy path', () => {
  it('grants credit, records the redemption, bumps the count, and rolls expires_at forward', async () => {
    // Seed a stale (past) expiry so the rolling-clock roll-forward is unambiguous.
    const staleExpiry = new Date('2020-01-01T00:00:00.000Z');
    const { wallet, companyId } = await creditWalletFactory({ values: { expiresAt: staleExpiry } });
    const redeemer = await userFactory();
    const code = await promoCodeFactory({
      values: {
        code: 'GRANT50',
        grantMinor: 5000,
        perCodeRedemptionCap: 100,
        redeemedCount: 3,
        ...IN_WINDOW,
      },
    });

    const result = await redeem({
      code: 'grant50',
      companyId,
      walletId: wallet.id,
      redeemedByUserId: redeemer.id,
      now: NOW,
    });

    expect(result.outcome).toBe('redeemed');
    if (result.outcome !== 'redeemed') throw new Error('expected redeemed');
    expect(result.grantMinor).toBe(5000);
    expect(result.ledgerEntryId).toBeDefined();

    // A single ledger grant: reason='promo', entry_type='adjustment', system entry (no member).
    const ledgerRows = await creditLedgerRepository.listByWallet(wallet.id);
    expect(ledgerRows).toHaveLength(1);
    const [entry] = ledgerRows;
    expect(entry?.id).toBe(result.ledgerEntryId);
    expect(entry?.reason).toBe('promo');
    expect(entry?.entryType).toBe('adjustment');
    expect(entry?.amountMinor).toBe(5000);
    expect(entry?.memberId).toBeNull();

    // A promo_redemptions row with the snapshot grant + attribution.
    const redemptions = await db
      .select()
      .from(promoRedemptions)
      .where(eq(promoRedemptions.companyId, companyId));
    expect(redemptions).toHaveLength(1);
    const [redemption] = redemptions;
    expect(redemption?.promoCodeId).toBe(code.id);
    expect(redemption?.grantedMinor).toBe(5000);
    expect(redemption?.ledgerEntryId).toBe(result.ledgerEntryId);
    expect(redemption?.redeemedByUserId).toBe(redeemer.id);

    // redeemed_count + 1 (3 -> 4).
    const afterCode = await promoCodesRepository.getById(code.id);
    expect(afterCode?.redeemedCount).toBe(4);

    // Balance credited + expires_at rolled forward to ~now + 12 months (rolling-expiry clock
    // applies to a promo grant exactly like a purchase — only entry_type='expiry' is excluded).
    const afterWallet = await creditWalletsRepository.findById(wallet.id);
    expect(afterWallet?.balanceMinor).toBe(5000);
    expect(afterWallet?.expiresAt).not.toBeNull();
    const stamped = afterWallet?.expiresAt as Date;
    expect(stamped.getTime()).toBeGreaterThan(staleExpiry.getTime());
    const monthsAhead = (stamped.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30);
    expect(monthsAhead).toBeGreaterThan(11);
    expect(monthsAhead).toBeLessThan(13);
  });

  it('accepts a null redeemer (system-promo attribution path)', async () => {
    const { wallet, companyId } = await creditWalletFactory();
    const code = await promoCodeFactory({ values: { code: 'SYSGRANT', ...IN_WINDOW } });

    const result = await redeem({
      code: 'SYSGRANT',
      companyId,
      walletId: wallet.id,
      redeemedByUserId: null,
      now: NOW,
    });

    expect(result.outcome).toBe('redeemed');
    const [redemption] = await db
      .select()
      .from(promoRedemptions)
      .where(eq(promoRedemptions.companyId, companyId));
    expect(redemption?.redeemedByUserId).toBeNull();
  });
});

describe('promoRedemptionsRepository.redeem — single-use per company', () => {
  it('a second redeem for the same company is already_redeemed and never double-grants', async () => {
    const { wallet, companyId } = await creditWalletFactory();
    const redeemer = await userFactory();
    const code = await promoCodeFactory({
      values: {
        code: 'SINGLE',
        grantMinor: 4000,
        perCodeRedemptionCap: 100,
        redeemedCount: 1,
        ...IN_WINDOW,
      },
    });

    const first = await redeem({
      code: 'SINGLE',
      companyId,
      walletId: wallet.id,
      redeemedByUserId: redeemer.id,
      now: NOW,
    });
    expect(first.outcome).toBe('redeemed');

    const second = await redeem({
      code: 'SINGLE',
      companyId,
      walletId: wallet.id,
      redeemedByUserId: redeemer.id,
      now: NOW,
    });
    expect(second.outcome).toBe('already_redeemed');

    // redeemed_count bumped exactly once (1 -> 2, NOT 3).
    const afterCode = await promoCodesRepository.getById(code.id);
    expect(afterCode?.redeemedCount).toBe(2);

    // Exactly one redemption row + one ledger grant; balance granted once.
    const redemptions = await db
      .select()
      .from(promoRedemptions)
      .where(eq(promoRedemptions.companyId, companyId));
    expect(redemptions).toHaveLength(1);
    expect(await creditLedgerRepository.listByWallet(wallet.id)).toHaveLength(1);
    const afterWallet = await creditWalletsRepository.findById(wallet.id);
    expect(afterWallet?.balanceMinor).toBe(4000);
  });

  it('the (promo_code_id, company_id) unique rejects a duplicate redemption at the DB', async () => {
    const code = await promoCodeFactory({ values: { code: 'UNIQ', ...IN_WINDOW } });
    const company = await companyFactory();

    // First redemption (each factory call seeds a distinct wallet ⇒ distinct ledger entry).
    await promoRedemptionFactory({ promoCodeId: code.id, companyId: company.id });

    // A second redemption for the SAME (code, company) must be rejected by the new unique
    // index, even with a distinct ledger_entry_id.
    await expect(
      promoRedemptionFactory({ promoCodeId: code.id, companyId: company.id })
    ).rejects.toThrow();
  });
});

describe('promoRedemptionsRepository.redeem — idempotent replay', () => {
  it('a bare ledger-key replay short-circuits to already_redeemed (no redemption, no count bump)', async () => {
    const { wallet, companyId } = await creditWalletFactory();
    const code = await promoCodeFactory({
      values: { code: 'REPLAY', grantMinor: 6000, redeemedCount: 2, ...IN_WINDOW },
    });

    // Pre-post the promo ledger entry under the exact key redeem will derive — simulating a
    // ledger grant that already landed. redeem must detect the dedup and NOT record a second
    // redemption or bump the count.
    await creditLedgerRepository.postEntry({
      walletId: wallet.id,
      entryType: 'adjustment',
      reason: 'promo',
      amountMinor: 6000,
      idempotencyKey: deriveIdempotencyKey({
        reason: 'promo',
        walletId: wallet.id,
        promoCodeId: code.id,
      }),
    });

    const result = await redeem({
      code: 'REPLAY',
      companyId,
      walletId: wallet.id,
      redeemedByUserId: null,
      now: NOW,
    });

    expect(result.outcome).toBe('already_redeemed');
    // No redemption row, count untouched, one ledger entry, balance granted once.
    const redemptions = await db
      .select()
      .from(promoRedemptions)
      .where(eq(promoRedemptions.companyId, companyId));
    expect(redemptions).toHaveLength(0);
    const afterCode = await promoCodesRepository.getById(code.id);
    expect(afterCode?.redeemedCount).toBe(2);
    expect(await creditLedgerRepository.listByWallet(wallet.id)).toHaveLength(1);
    const afterWallet = await creditWalletsRepository.findById(wallet.id);
    expect(afterWallet?.balanceMinor).toBe(6000);
  });
});

describe('promoRedemptionsRepository.redeem — error branches + cap under lock', () => {
  it('throws PromoInvalidError for an unknown / deactivated code', async () => {
    const { wallet, companyId } = await creditWalletFactory();

    await expect(
      redeem({
        code: 'MISSING',
        companyId,
        walletId: wallet.id,
        redeemedByUserId: null,
        now: NOW,
      })
    ).rejects.toBeInstanceOf(PromoInvalidError);

    await promoCodeFactory({ values: { code: 'DEACT', status: 'deactivated', ...IN_WINDOW } });
    await expect(
      redeem({ code: 'DEACT', companyId, walletId: wallet.id, redeemedByUserId: null, now: NOW })
    ).rejects.toBeInstanceOf(PromoInvalidError);
  });

  it('throws PromoScheduledError before the window opens and PromoExpiredError after it closes', async () => {
    const { wallet, companyId } = await creditWalletFactory();

    await promoCodeFactory({
      values: {
        code: 'NOTYET',
        validFrom: new Date('2027-01-01T00:00:00.000Z'),
        validUntil: new Date('2027-12-31T00:00:00.000Z'),
      },
    });
    await expect(
      redeem({ code: 'NOTYET', companyId, walletId: wallet.id, redeemedByUserId: null, now: NOW })
    ).rejects.toBeInstanceOf(PromoScheduledError);

    await promoCodeFactory({
      values: {
        code: 'CLOSED',
        validFrom: new Date('2025-01-01T00:00:00.000Z'),
        validUntil: new Date('2025-12-31T00:00:00.000Z'),
      },
    });
    await expect(
      redeem({ code: 'CLOSED', companyId, walletId: wallet.id, redeemedByUserId: null, now: NOW })
    ).rejects.toBeInstanceOf(PromoExpiredError);

    // Nothing was granted for either failing redeem.
    expect(await creditLedgerRepository.listByWallet(wallet.id)).toHaveLength(0);
  });

  it('enforces the global cap across companies (deterministic, under the row lock)', async () => {
    const code = await promoCodeFactory({
      values: {
        code: 'CAP1',
        grantMinor: 3000,
        perCodeRedemptionCap: 1,
        redeemedCount: 0,
        ...IN_WINDOW,
      },
    });

    // Company A redeems — consumes the only slot.
    const a = await creditWalletFactory();
    const firstRedeemer = await userFactory();
    const first = await redeem({
      code: 'CAP1',
      companyId: a.companyId,
      walletId: a.wallet.id,
      redeemedByUserId: firstRedeemer.id,
      now: NOW,
    });
    expect(first.outcome).toBe('redeemed');
    expect((await promoCodesRepository.getById(code.id))?.redeemedCount).toBe(1);

    // Company B is now over cap → PromoExhaustedError; no grant landed on B's wallet.
    const b = await creditWalletFactory();
    await expect(
      redeem({
        code: 'CAP1',
        companyId: b.companyId,
        walletId: b.wallet.id,
        redeemedByUserId: null,
        now: NOW,
      })
    ).rejects.toBeInstanceOf(PromoExhaustedError);
    expect(await creditLedgerRepository.listByWallet(b.wallet.id)).toHaveLength(0);
  });

  it('a replay of an exhausted code by the SAME company stays idempotent (no false PromoExhaustedError)', async () => {
    const { wallet, companyId } = await creditWalletFactory();
    const code = await promoCodeFactory({
      values: {
        code: 'CAPREPLAY',
        grantMinor: 2000,
        perCodeRedemptionCap: 1,
        redeemedCount: 0,
        ...IN_WINDOW,
      },
    });

    const first = await redeem({
      code: 'CAPREPLAY',
      companyId,
      walletId: wallet.id,
      redeemedByUserId: null,
      now: NOW,
    });
    expect(first.outcome).toBe('redeemed');
    // Cap is now hit (count 1 of 1). A replay by the same company must NOT throw exhausted —
    // the single-use check precedes the cap check.
    const replay = await redeem({
      code: 'CAPREPLAY',
      companyId,
      walletId: wallet.id,
      redeemedByUserId: null,
      now: NOW,
    });
    expect(replay.outcome).toBe('already_redeemed');
    expect((await promoCodesRepository.getById(code.id))?.redeemedCount).toBe(1);
  });
});
