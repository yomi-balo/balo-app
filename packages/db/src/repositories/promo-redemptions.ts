import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import { promoCodes, promoRedemptions } from '../schema';
import { applyLedgerEntry } from './credit-ledger';
import { deriveIdempotencyKey } from './_shared/credit-idempotency';
import { normalizePromoCode } from './promo-codes';

/** Active transaction handle (matches the credit repos / `promo-codes.ts` pattern). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * promoRedemptionsRepository (BAL-377 / ADR-1040 Lane 1) — the reusable promo redeem
 * engine. Two entry points, both designed for reuse by BAL-383 (standalone redeem) and
 * the api Stripe webhook:
 *
 *  - `validate({ code, companyId, now })` — READ-ONLY apply-time check. Returns a
 *    discriminated union of the exact reason a code cannot be redeemed (or `ok:true`
 *    with the grant), so the UI can render a per-reason error line.
 *  - `redeem(tx, …)` — the TX-COMPOSABLE write engine. Runs INSIDE the caller's
 *    transaction (the webhook's `db.transaction`), under a `SELECT … FOR UPDATE` on the
 *    `promo_codes` row (mirrors `promoCodesRepository.updateCap`), so it serialises with
 *    both a concurrent cap-edit and concurrent redeems. Grants credit via the single
 *    authoritative `applyLedgerEntry` primitive (`entry_type='adjustment'`,
 *    `reason='promo'`) — which automatically rolls the wallet's rolling-expiry clock like
 *    any purchase (only `entry_type='expiry'` is excluded) — records the append-only
 *    `promo_redemptions` row, and bumps `promo_codes.redeemed_count`. Idempotent on replay
 *    (see `redeem`).
 *
 * The `promo` ledger entry is a SYSTEM entry (`memberId:null`, NOT in
 * `AUDIT_ACTION_BY_REASON` → no `audit_events` row); the `redeemed_by_user_id` /
 * `company_id` columns carry the ADR-1030/1029 person/party attribution instead.
 */

/**
 * Thrown by `redeem` when the code cannot be resolved to an ACTIVE, non-soft-deleted
 * `promo_codes` row (missing, soft-deleted, or `status='deactivated'`). The apply-time
 * `validate` maps this same condition to `reason:'invalid'`.
 */
export class PromoInvalidError extends Error {
  constructor(public readonly code: string) {
    super(`Promo code is not valid: ${code}`);
    this.name = 'PromoInvalidError';
  }
}

/** Thrown by `redeem` when `now < valid_from` (the window has not opened yet). */
export class PromoScheduledError extends Error {
  constructor(public readonly code: string) {
    super(`Promo code is not active yet: ${code}`);
    this.name = 'PromoScheduledError';
  }
}

/** Thrown by `redeem` when `now > valid_until` (the window has closed). */
export class PromoExpiredError extends Error {
  constructor(public readonly code: string) {
    super(`Promo code has expired: ${code}`);
    this.name = 'PromoExpiredError';
  }
}

/** Thrown by `redeem` when `redeemed_count >= per_code_redemption_cap` (global cap hit). */
export class PromoExhaustedError extends Error {
  constructor(public readonly code: string) {
    super(`Promo code has reached its redemption cap: ${code}`);
    this.name = 'PromoExhaustedError';
  }
}

/**
 * Thrown when a caller wants a HARD single-use failure rather than the idempotent
 * `already_redeemed` outcome. `redeem` itself treats a company that has already redeemed a
 * code as an idempotent no-op (`{ outcome:'already_redeemed' }`) — the correct behaviour for
 * the webhook replay path, since `company_id ↔ wallet_id` is 1:1 so a repeat redemption of
 * the same code by the same company IS a replay of the same grant. This error is exported
 * for a future stricter apply-time guard (e.g. BAL-383) that prefers to reject a repeat.
 */
export class PromoAlreadyRedeemedError extends Error {
  constructor(
    public readonly code: string,
    public readonly companyId: string
  ) {
    super(`Promo code already redeemed by this company: ${code}`);
    this.name = 'PromoAlreadyRedeemedError';
  }
}

/** The reason a code cannot be redeemed at apply-time (`validate`). */
export type PromoValidationReason =
  | 'invalid'
  | 'scheduled'
  | 'expired'
  | 'exhausted'
  | 'already_used';

/** Result of the read-only apply-time `validate`. */
export type PromoValidation =
  | { ok: false; reason: PromoValidationReason }
  | { ok: true; promoCodeId: string; grantMinor: number };

/** Result of the tx-composable `redeem`. */
export type RedeemResult =
  | { outcome: 'redeemed'; grantMinor: number; ledgerEntryId: string }
  | { outcome: 'already_redeemed' };

export interface ValidatePromoInput {
  code: string;
  companyId: string;
  now: Date;
}

export interface RedeemPromoInput {
  code: string;
  companyId: string;
  walletId: string;
  /** ADR-1030 actor — nullable (a hypothetical future system promo has no human redeemer). */
  redeemedByUserId: string | null;
  now: Date;
}

export const promoRedemptionsRepository = {
  /**
   * READ-ONLY apply-time validation. Normalises the code, fetches the active
   * (non-soft-deleted) `promo_codes` row, then evaluates status → window → cap →
   * single-use in that order, returning the FIRST failing reason. `already_used` means a
   * `promo_redemptions` row already exists for `(promoCodeId, companyId)`. On success
   * returns the id + grant so the caller can render the bonus. NO lock, NO writes — the
   * authoritative re-check happens in `redeem` under the row lock.
   */
  async validate(input: ValidatePromoInput): Promise<PromoValidation> {
    const normalized = normalizePromoCode(input.code);

    const [promo] = await db
      .select()
      .from(promoCodes)
      .where(and(eq(promoCodes.code, normalized), isNull(promoCodes.deletedAt)))
      .limit(1);

    if (promo === undefined || promo.status !== 'active') {
      return { ok: false, reason: 'invalid' };
    }
    if (input.now < promo.validFrom) {
      return { ok: false, reason: 'scheduled' };
    }
    if (input.now > promo.validUntil) {
      return { ok: false, reason: 'expired' };
    }
    if (promo.redeemedCount >= promo.perCodeRedemptionCap) {
      return { ok: false, reason: 'exhausted' };
    }

    const [existing] = await db
      .select({ id: promoRedemptions.id })
      .from(promoRedemptions)
      .where(
        and(
          eq(promoRedemptions.promoCodeId, promo.id),
          eq(promoRedemptions.companyId, input.companyId)
        )
      )
      .limit(1);
    if (existing !== undefined) {
      return { ok: false, reason: 'already_used' };
    }

    return { ok: true, promoCodeId: promo.id, grantMinor: promo.grantMinor };
  },

  /**
   * TX-COMPOSABLE redeem engine. Runs inside the caller's `tx` (so the grant, the
   * redemption record, and the count bump commit atomically with the caller's own work —
   * e.g. the webhook's base purchase credit). Algorithm, under a `SELECT … FOR UPDATE` on
   * the `promo_codes` row:
   *
   *  1. Normalise + lock the active (non-deleted) code row → `PromoInvalidError` if absent
   *     / `status!=='active'`.
   *  2. Window: `now < valid_from` → `PromoScheduledError`; `now > valid_until` →
   *     `PromoExpiredError`.
   *  3. Single-use / idempotent replay: an existing `promo_redemptions` row for
   *     `(promoCodeId, companyId)` → `{ outcome:'already_redeemed' }`. Checked BEFORE the
   *     cap so a replay of a now-exhausted code stays idempotent (never a false
   *     `PromoExhaustedError`).
   *  4. Cap: `redeemed_count >= per_code_redemption_cap` → `PromoExhaustedError` (the
   *     `promo_codes_redeemed_within_cap` CHECK is the hard backstop).
   *  5. Grant via `applyLedgerEntry` (`adjustment`/`promo`, `memberId:null`), keyed
   *     `promo:{walletId}:{normalizedCode}`. A `deduped` result (the ledger key already
   *     existed) short-circuits to `already_redeemed` without inserting/incrementing.
   *  6. Insert `promo_redemptions` with `onConflictDoNothing` on the
   *     `(promo_code_id, company_id)` unique — a conflict (a concurrent redeem beat us
   *     between steps 3 and 6) also yields `already_redeemed`.
   *  7. `UPDATE promo_codes SET redeemed_count = redeemed_count + 1`.
   *
   * A throw in any step rolls the whole thing back with the caller's transaction. The
   * increment (7) fires ONLY on a fresh grant, so a replay never double-counts.
   */
  async redeem(tx: DbTx, input: RedeemPromoInput): Promise<RedeemResult> {
    const normalized = normalizePromoCode(input.code);

    // 1. Lock the active code row (serialises with updateCap + concurrent redeems).
    const [promo] = await tx
      .select()
      .from(promoCodes)
      .where(and(eq(promoCodes.code, normalized), isNull(promoCodes.deletedAt)))
      .for('update');

    if (promo === undefined || promo.status !== 'active') {
      throw new PromoInvalidError(normalized);
    }
    // 2. Window.
    if (input.now < promo.validFrom) {
      throw new PromoScheduledError(normalized);
    }
    if (input.now > promo.validUntil) {
      throw new PromoExpiredError(normalized);
    }

    // 3. Single-use / idempotent replay (before the cap check — a replay of an exhausted
    //    code must stay idempotent).
    const [existing] = await tx
      .select({ id: promoRedemptions.id })
      .from(promoRedemptions)
      .where(
        and(
          eq(promoRedemptions.promoCodeId, promo.id),
          eq(promoRedemptions.companyId, input.companyId)
        )
      )
      .limit(1);
    if (existing !== undefined) {
      return { outcome: 'already_redeemed' };
    }

    // 4. Cap.
    if (promo.redeemedCount >= promo.perCodeRedemptionCap) {
      throw new PromoExhaustedError(normalized);
    }

    // 5. Grant via the single authoritative ledger primitive. `reason:'promo'` is a system
    //    entry (memberId:null valid, no audit row); the entry inherits the rolling-expiry
    //    clock automatically (only entry_type='expiry' is excluded).
    const grantMinor = promo.grantMinor;
    const ledger = await applyLedgerEntry(tx, {
      walletId: input.walletId,
      entryType: 'adjustment',
      reason: 'promo',
      amountMinor: grantMinor,
      idempotencyKey: deriveIdempotencyKey({
        reason: 'promo',
        walletId: input.walletId,
        promoCode: normalized,
      }),
      memberId: null,
    });
    if (ledger.deduped) {
      // The ledger already held this grant (key replay) — do not record a second
      // redemption or bump the count.
      return { outcome: 'already_redeemed' };
    }

    // 6. Record the redemption. `onConflictDoNothing` on the (promo_code_id, company_id)
    //    unique is the concurrency backstop: a redeem that raced past step 3 conflicts here.
    const [redemption] = await tx
      .insert(promoRedemptions)
      .values({
        promoCodeId: promo.id,
        companyId: input.companyId,
        grantedMinor: grantMinor,
        ledgerEntryId: ledger.entry.id,
        redeemedByUserId: input.redeemedByUserId,
      })
      .onConflictDoNothing({
        target: [promoRedemptions.promoCodeId, promoRedemptions.companyId],
      })
      .returning();
    if (redemption === undefined) {
      return { outcome: 'already_redeemed' };
    }

    // 7. Bump the global redemption count (atomic increment; the
    //    promo_codes_redeemed_within_cap CHECK backstops the invariant).
    await tx
      .update(promoCodes)
      .set({ redeemedCount: sql`${promoCodes.redeemedCount} + 1` })
      .where(eq(promoCodes.id, promo.id));

    return { outcome: 'redeemed', grantMinor, ledgerEntryId: ledger.entry.id };
  },
};
