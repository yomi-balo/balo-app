import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  companies,
  promoCodes,
  promoRedemptions,
  users,
  type PromoCode,
  type PromoRedemption,
} from '../schema';
import { creditWalletsRepository } from './credit-wallets';
import { applyLedgerEntry } from './credit-ledger';
import { deriveIdempotencyKey } from './_shared/credit-idempotency';

/** Active transaction handle (matches the credit repos / engagements pattern). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The single write-boundary normalizer for a promo `code`: trim + uppercase. Applied
 * before insert AND before the (BAL-383) redeem lookup so uniqueness is effectively
 * case-insensitive (`welcome50` and `WELCOME50` collide). PURE — no I/O.
 */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Thrown when creating a code whose normalized value already exists on an active
 * (non-soft-deleted) row — surfaced from the `promo_codes_code_active_idx` partial
 * unique (also the backstop for the concurrent-creation race).
 */
export class DuplicatePromoCodeError extends Error {
  constructor(public readonly code: string) {
    super(`A promo code already exists: ${code}`);
    this.name = 'DuplicatePromoCodeError';
  }
}

/** Thrown when a mutation (deactivate / cap-edit) targets a missing or soft-deleted code. */
export class PromoCodeNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Promo code not found: ${id}`);
    this.name = 'PromoCodeNotFoundError';
  }
}

/**
 * Thrown when a cap edit would drop `per_code_redemption_cap` below the code's current
 * `redeemed_count`. The friendly guard for the `promo_codes_redeemed_within_cap` CHECK.
 */
export class CapBelowRedeemedCountError extends Error {
  constructor(
    public readonly redeemedCount: number,
    public readonly attemptedCap: number
  ) {
    super(
      `Cannot lower cap to ${attemptedCap}: ${redeemedCount} redemptions have already been made`
    );
    this.name = 'CapBelowRedeemedCountError';
  }
}

export interface CreatePromoCodeInput {
  code: string;
  grantMinor: number;
  perCodeRedemptionCap: number;
  validFrom: Date;
  validUntil: Date;
  createdBy: string;
}

export interface UpdatePromoCapInput {
  id: string;
  newCap: number;
}

/**
 * A flat redemption tracking row — an EXPLICIT column projection (never `with:` full-row
 * hydration, which would leak PII/secrets, memory reference_drizzle_with_hydration_leaks_secrets).
 * `companyName` / actor name come from LEFT JOINs. The loader groups these by
 * `promoCodeId` in the pure view-model (one flat read, no N+1).
 */
export interface PromoRedemptionRecord {
  id: string;
  promoCodeId: string;
  companyId: string;
  companyName: string;
  redeemedByUserId: string | null;
  redeemedByFirstName: string | null;
  redeemedByLastName: string | null;
  grantedMinor: number;
  redeemedAt: Date;
}

/** Input to `redeem` (BAL-383). */
export interface RedeemPromoInput {
  /** Raw user entry; normalized inside via `normalizePromoCode` (case-insensitive). */
  rawCode: string;
  /** The redeeming PARTY (session.companyId — always present, ADR-1029 rights). */
  companyId: string;
  /** The individual actor (ADR-1030 attribution). */
  redeemedByUserId: string;
  /** Injectable clock for deterministic tests (defaults to `new Date()`). */
  now?: Date;
}

/**
 * Discriminated result of a redeem attempt. The "warm refusal" outcomes are TYPED (not
 * thrown) so the Server Action can render warm, non-adversarial copy; only true faults
 * (a vanished wallet, a DB error) throw and bubble to the caller's error boundary.
 */
export type RedeemPromoResult =
  | {
      outcome: 'redeemed';
      redemption: PromoRedemption;
      grantedMinor: number;
      balanceAfterMinor: number;
      redeemedCount: number;
      perCodeRedemptionCap: number;
    }
  | { outcome: 'already_redeemed'; redemption: PromoRedemption; grantedMinor: number }
  | { outcome: 'not_found' }
  | { outcome: 'scheduled'; validFrom: Date } // valid_from in the future (code not active yet)
  | { outcome: 'expired'; validUntil: Date }
  | { outcome: 'deactivated' }
  | { outcome: 'exhausted' };

export const promoCodesRepository = {
  /**
   * Mint a promo code. Normalizes `code`; inserts. The `promo_codes_code_active_idx`
   * partial unique arbiter (`onConflictDoNothing` with a matching `deleted_at IS NULL`
   * predicate) turns a duplicate — including a concurrent-creation race — into
   * `DuplicatePromoCodeError`. DB CHECKs backstop grant/cap/window bounds.
   */
  async create(input: CreatePromoCodeInput): Promise<PromoCode> {
    const code = normalizePromoCode(input.code);
    const [row] = await db
      .insert(promoCodes)
      .values({
        code,
        grantMinor: input.grantMinor,
        perCodeRedemptionCap: input.perCodeRedemptionCap,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        createdBy: input.createdBy,
      })
      .onConflictDoNothing({
        target: promoCodes.code, // arbiter = the PARTIAL unique index
        where: isNull(promoCodes.deletedAt), // predicate MUST match the index exactly
      })
      .returning();

    if (row === undefined) {
      throw new DuplicatePromoCodeError(code);
    }
    return row;
  },

  /** All active (non-soft-deleted) codes, newest first. */
  async list(): Promise<PromoCode[]> {
    return db
      .select()
      .from(promoCodes)
      .where(isNull(promoCodes.deletedAt))
      .orderBy(desc(promoCodes.createdAt));
  },

  /** A single active (non-soft-deleted) code by id. */
  async getById(id: string): Promise<PromoCode | undefined> {
    const [row] = await db
      .select()
      .from(promoCodes)
      .where(and(eq(promoCodes.id, id), isNull(promoCodes.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * Turn a code off (status → 'deactivated'). One-way (no reactivation this ticket).
   * Missing / soft-deleted code → `PromoCodeNotFoundError`. Idempotent: re-deactivating
   * an already-`deactivated` code is a no-op that still returns the row.
   */
  async deactivate(id: string): Promise<PromoCode> {
    const [row] = await db
      .update(promoCodes)
      .set({ status: 'deactivated' })
      .where(and(eq(promoCodes.id, id), isNull(promoCodes.deletedAt)))
      .returning();

    if (row === undefined) {
      throw new PromoCodeNotFoundError(id);
    }
    return row;
  },

  /**
   * Change a code's redemption cap under a ROW LOCK (`SELECT … FOR UPDATE`), which
   * serializes against a concurrent BAL-383 redeem's row lock. Guards: missing /
   * soft-deleted → `PromoCodeNotFoundError`; `newCap < redeemed_count` →
   * `CapBelowRedeemedCountError` (the `promo_codes_redeemed_within_cap` CHECK is the
   * hard backstop even if a caller bypasses the repo).
   */
  async updateCap(input: UpdatePromoCapInput): Promise<PromoCode> {
    return db.transaction(async (tx: DbTx) => {
      const [current] = await tx
        .select()
        .from(promoCodes)
        .where(and(eq(promoCodes.id, input.id), isNull(promoCodes.deletedAt)))
        .for('update');

      if (current === undefined) {
        throw new PromoCodeNotFoundError(input.id);
      }
      if (input.newCap < current.redeemedCount) {
        throw new CapBelowRedeemedCountError(current.redeemedCount, input.newCap);
      }

      const [updated] = await tx
        .update(promoCodes)
        .set({ perCodeRedemptionCap: input.newCap })
        .where(eq(promoCodes.id, input.id))
        .returning();
      if (updated === undefined) {
        throw new PromoCodeNotFoundError(input.id);
      }
      return updated;
    });
  },

  /**
   * Redeem a promo code (BAL-383) — the SOLE writer of `redeemed_count` and the SOLE
   * inserter of `promo_redemptions`. Grants a fixed slice of AUD credit to the redeeming
   * company's wallet in ONE `db.transaction`: atomic (grant + redemption row + count bump
   * commit together) and idempotent on retry.
   *
   * Warm refusals (`not_found` / `scheduled` / `expired` / `deactivated` / `exhausted` /
   * `already_redeemed`) return a TYPED outcome rather than throwing, so the caller renders
   * warm copy; only true faults (a vanished wallet, a DB error) throw.
   *
   * Algorithm (single txn):
   *  1. Normalize the code; SELECT the promo row `.for('update')` by `(code, deleted_at IS
   *     NULL)` (rides `promo_codes_code_active_idx`). Absent → `not_found`. This ROW LOCK
   *     serializes concurrent redeems of the SAME code (cap correctness) AND against
   *     `updateCap`'s row lock.
   *  2. Dedup FIRST (before validity/cap): an existing `promo_redemptions` for
   *     `(promoCodeId, companyId)` → `already_redeemed` with NO writes. Single-use per
   *     company; a retried Server Action / 2nd attempt collapses here without touching cap
   *     or balance.
   *  3. Runtime enforcement under the lock (precedence deactivated > expired > scheduled >
   *     exhausted): return the matching typed refusal.
   *  4. `ensureForCompany(tx, companyId)` — find-or-create the wallet inside the txn.
   *  5. `applyLedgerEntry(tx, { reason:'promo', entryType:'adjustment', amountMinor:
   *     grantMinor, idempotencyKey: promo:${walletId}:${CODE}, memberId:null })`. `promo` is
   *     a SYSTEM reason (excluded from `AUDIT_ACTION_BY_REASON`) so `memberId:null` is
   *     correct and NO `audit_events` row is written — the `promo_redemptions` row IS the
   *     ADR-1030 attribution record. A `deduped:true` return (a prior grant already posted
   *     this exact key) → re-select the redemption by `ledgerEntryId` → `already_redeemed`
   *     WITHOUT steps 6/7.
   *  6. Insert the `promo_redemptions` row (snapshot grant + ledgerEntryId + actor). The
   *     `promo_redemptions_ledger_entry_idx` unique is the hard backstop; `onConflictDoNothing`
   *     + re-select collapses a raced double-insert to a warm `already_redeemed` (never a raw
   *     23505).
   *  7. `UPDATE promo_codes SET redeemed_count = redeemed_count + 1 RETURNING`. The
   *     `promo_codes_redeemed_within_cap` CHECK is the hard backstop; step 3 is the friendly
   *     guard. Holding the row lock from step 1 makes the step-3 read + this increment
   *     consistent (no lost update).
   *
   * LOCK ORDER (deadlock-free): every redeem takes the promo_codes ROW LOCK (step 1) BEFORE
   * the wallet ADVISORY LOCK (inside `applyLedgerEntry`, step 5) — one consistent order.
   * `updateCap` takes only the promo lock; consume / top-up / dormancy take only the wallet
   * lock. No code path acquires the two locks in the opposite order, so no cycle is possible.
   */
  async redeem(input: RedeemPromoInput): Promise<RedeemPromoResult> {
    const code = normalizePromoCode(input.rawCode);
    const now = input.now ?? new Date();

    return db.transaction(async (tx: DbTx): Promise<RedeemPromoResult> => {
      // 1. Lock the active promo row (serializes same-code redeems + updateCap).
      const [promo] = await tx
        .select()
        .from(promoCodes)
        .where(and(eq(promoCodes.code, code), isNull(promoCodes.deletedAt)))
        .for('update');
      if (promo === undefined) {
        return { outcome: 'not_found' };
      }

      // 2. Dedup FIRST — single-use per company; a repeat is a no-write warm outcome.
      const [existingRedemption] = await tx
        .select()
        .from(promoRedemptions)
        .where(
          and(
            eq(promoRedemptions.promoCodeId, promo.id),
            eq(promoRedemptions.companyId, input.companyId)
          )
        )
        .limit(1);
      if (existingRedemption !== undefined) {
        return {
          outcome: 'already_redeemed',
          redemption: existingRedemption,
          grantedMinor: existingRedemption.grantedMinor,
        };
      }

      // 3. Runtime enforcement under the lock (deactivated > expired > scheduled > exhausted).
      if (promo.status === 'deactivated') {
        return { outcome: 'deactivated' };
      }
      if (now >= promo.validUntil) {
        return { outcome: 'expired', validUntil: promo.validUntil };
      }
      if (now < promo.validFrom) {
        return { outcome: 'scheduled', validFrom: promo.validFrom };
      }
      if (promo.redeemedCount >= promo.perCodeRedemptionCap) {
        return { outcome: 'exhausted' };
      }

      // 4. Find-or-create the wallet inside the txn (first-ever credit event needs no purchase).
      const wallet = await creditWalletsRepository.ensureForCompany(tx, input.companyId);

      // 5. Post the promo grant. System reason → memberId null, no audit row. The deterministic
      //    key makes a re-run collapse onto the SAME ledger entry (idempotent).
      const idempotencyKey = deriveIdempotencyKey({
        reason: 'promo',
        walletId: wallet.id,
        promoCode: code,
      });
      const result = await applyLedgerEntry(tx, {
        walletId: wallet.id,
        entryType: 'adjustment',
        reason: 'promo',
        amountMinor: promo.grantMinor,
        idempotencyKey,
        memberId: null,
      });

      if (result.deduped) {
        // Belt to step-2's suspenders: a prior grant already posted this exact key. The
        // `promo_redemptions` row is that grant's attribution record — collapse to a warm
        // `already_redeemed` without re-inserting or bumping the count.
        const [priorRedemption] = await tx
          .select()
          .from(promoRedemptions)
          .where(eq(promoRedemptions.ledgerEntryId, result.entry.id))
          .limit(1);
        if (priorRedemption === undefined) {
          throw new Error(
            `redeem: promo ledger entry ${result.entry.id} has no redemption row (integrity violation)`
          );
        }
        return {
          outcome: 'already_redeemed',
          redemption: priorRedemption,
          grantedMinor: priorRedemption.grantedMinor,
        };
      }

      // 6. Insert the redemption row; the ledger_entry_id unique backstops a raced double-insert.
      const [insertedRedemption] = await tx
        .insert(promoRedemptions)
        .values({
          promoCodeId: promo.id,
          companyId: input.companyId,
          grantedMinor: promo.grantMinor,
          ledgerEntryId: result.entry.id,
          redeemedByUserId: input.redeemedByUserId,
        })
        .onConflictDoNothing({ target: promoRedemptions.ledgerEntryId })
        .returning();

      if (insertedRedemption === undefined) {
        const [racedRedemption] = await tx
          .select()
          .from(promoRedemptions)
          .where(eq(promoRedemptions.ledgerEntryId, result.entry.id))
          .limit(1);
        if (racedRedemption === undefined) {
          throw new Error(
            `redeem: redemption insert conflicted but no row found for ledger entry ${result.entry.id}`
          );
        }
        return {
          outcome: 'already_redeemed',
          redemption: racedRedemption,
          grantedMinor: racedRedemption.grantedMinor,
        };
      }

      // 7. Bump redeemed_count (CHECK `<= per_code_redemption_cap` is the hard backstop).
      const [updatedPromo] = await tx
        .update(promoCodes)
        .set({ redeemedCount: sql`${promoCodes.redeemedCount} + 1` })
        .where(eq(promoCodes.id, promo.id))
        .returning();
      if (updatedPromo === undefined) {
        throw new Error(`redeem: promo code vanished during increment: ${promo.id}`);
      }

      return {
        outcome: 'redeemed',
        redemption: insertedRedemption,
        grantedMinor: promo.grantMinor,
        balanceAfterMinor: result.wallet.balanceMinor,
        redeemedCount: updatedPromo.redeemedCount,
        perCodeRedemptionCap: updatedPromo.perCodeRedemptionCap,
      };
    });
  },

  /**
   * All redemptions across every code, newest first — an EXPLICIT column projection
   * (never full-row hydration). `companies` is joined for the party name and `users` for
   * the actor's name. Empty until BAL-383. `companies` has no `deleted_at` — joins don't
   * filter it (memory reference_companies_table_no_deleted_at).
   *
   * `company_id` is a notNull RESTRICT FK ⇒ the company row always exists ⇒ INNER JOIN
   * (matching the party-join-requests precedent for a guaranteed FK), which yields a
   * non-null `companyName: string`. The actor is nullable (a future system promo has no
   * human redeemer) ⇒ LEFT JOIN `users`, so the name columns are `string | null`.
   */
  async listAllRedemptions(): Promise<PromoRedemptionRecord[]> {
    return db
      .select({
        id: promoRedemptions.id,
        promoCodeId: promoRedemptions.promoCodeId,
        companyId: promoRedemptions.companyId,
        companyName: companies.name,
        redeemedByUserId: promoRedemptions.redeemedByUserId,
        redeemedByFirstName: users.firstName,
        redeemedByLastName: users.lastName,
        grantedMinor: promoRedemptions.grantedMinor,
        redeemedAt: promoRedemptions.redeemedAt,
      })
      .from(promoRedemptions)
      .innerJoin(companies, eq(promoRedemptions.companyId, companies.id))
      .leftJoin(users, eq(promoRedemptions.redeemedByUserId, users.id))
      .orderBy(desc(promoRedemptions.redeemedAt));
  },
};
