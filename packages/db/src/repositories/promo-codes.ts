import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { companies, promoCodes, promoRedemptions, users, type PromoCode } from '../schema';

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
