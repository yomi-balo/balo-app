import { eq } from 'drizzle-orm';
import { db } from '../../client';
import { promoCodes, promoRedemptions } from '../../schema';
import type { NewPromoCode, PromoCode, PromoRedemption } from '../../schema';
import { creditLedgerRepository } from '../../repositories/credit-ledger';
import { deriveIdempotencyKey } from '../../repositories/_shared/credit-idempotency';
import { userFactory } from './user.factory';
import { creditWalletFactory } from './credit-wallet.factory';

let seq = 0;

interface PromoCodeFactoryOverrides {
  /** Reuse an existing minting admin instead of seeding one via `userFactory`. */
  createdBy?: string;
  /** Row-level overrides (code, grantMinor, perCodeRedemptionCap, redeemedCount, window, status, deletedAt, …). */
  values?: Partial<NewPromoCode>;
}

/**
 * Seeds a `promo_codes` row (BAL-384). Auto-seeds `created_by` via `userFactory` when no
 * `createdBy` is passed. Defaults: a unique uppercase `code`, $50 grant, cap 100, a window
 * of now → now + 30 days. Pass `values` to override — e.g. `values: { redeemedCount: 5 }`
 * to seed a partly-redeemed code for the cap-backstop tests, or `values: { deletedAt: new Date() }`
 * for the soft-delete-exclusion tests. Inserts directly (bypassing the repo's normalization)
 * so tests control the stored `code` exactly.
 */
export async function promoCodeFactory(
  overrides: PromoCodeFactoryOverrides = {}
): Promise<PromoCode> {
  seq++;
  const createdBy = overrides.createdBy ?? (await userFactory()).id;

  const now = Date.now();
  const defaults: NewPromoCode = {
    code: `PROMO${seq}${now}`,
    grantMinor: 5000,
    perCodeRedemptionCap: 100,
    validFrom: new Date(now),
    validUntil: new Date(now + 30 * 24 * 60 * 60 * 1000),
    createdBy,
  };

  const [row] = await db
    .insert(promoCodes)
    .values({ ...defaults, ...overrides.values })
    .returning();
  if (row === undefined) {
    throw new Error('promo code insert failed');
  }
  return row;
}

interface PromoRedemptionFactoryOverrides {
  /** Reuse an existing code instead of seeding one via `promoCodeFactory`. */
  promoCodeId?: string;
  /** The redeeming party. Defaults to the freshly-seeded wallet's company. */
  companyId?: string;
  /**
   * The individual actor. `undefined` seeds one via `userFactory`; pass `null` explicitly
   * to exercise the nullable (system-promo) attribution path.
   */
  redeemedByUserId?: string | null;
  /** Overrides the snapshot grant (defaults to the code's `grant_minor`). */
  grantedMinor?: number;
}

export interface PromoRedemptionFactoryResult {
  redemption: PromoRedemption;
  promoCodeId: string;
  companyId: string;
  ledgerEntryId: string;
  redeemedByUserId: string | null;
}

/**
 * Seeds a `promo_redemptions` row DIRECTLY (BAL-384 ships NO redemption write path — this
 * is how the read tests get rows). Composes the real dependency chain: `creditWalletFactory`
 * for a wallet + its company, then `creditLedgerRepository.postEntry({ reason:'promo',
 * entryType:'adjustment', … })` — keyed by `deriveIdempotencyKey({ reason:'promo', walletId,
 * promoCode })` — to obtain a genuine `credit_ledger.id` for the notNull `ledger_entry_id` FK,
 * and `userFactory` for the actor. Each call seeds a fresh wallet ⇒ a distinct `walletId` ⇒ a
 * distinct idempotency key ⇒ a distinct ledger entry (so the `ledger_entry_id` plain-unique is
 * always satisfied, even across repeated redemptions of the same code).
 */
export async function promoRedemptionFactory(
  overrides: PromoRedemptionFactoryOverrides = {}
): Promise<PromoRedemptionFactoryResult> {
  const promo =
    overrides.promoCodeId === undefined
      ? await promoCodeFactory()
      : await db.query.promoCodes.findFirst({ where: eq(promoCodes.id, overrides.promoCodeId) });
  if (promo === undefined) {
    throw new Error(`promo redemption factory: promo code not found: ${overrides.promoCodeId}`);
  }

  // A fresh wallet + its company give us the real ledger entry to point `ledger_entry_id` at.
  const { wallet, companyId: walletCompanyId } = await creditWalletFactory();
  const companyId = overrides.companyId ?? walletCompanyId;
  const grantedMinor = overrides.grantedMinor ?? promo.grantMinor;

  const redeemedByUserId =
    overrides.redeemedByUserId === undefined
      ? (await userFactory()).id
      : overrides.redeemedByUserId;

  const { entry } = await creditLedgerRepository.postEntry({
    walletId: wallet.id,
    entryType: 'adjustment',
    reason: 'promo',
    amountMinor: grantedMinor,
    idempotencyKey: deriveIdempotencyKey({
      reason: 'promo',
      walletId: wallet.id,
      promoCode: promo.code,
    }),
  });

  const [redemption] = await db
    .insert(promoRedemptions)
    .values({
      promoCodeId: promo.id,
      companyId,
      grantedMinor,
      ledgerEntryId: entry.id,
      redeemedByUserId,
    })
    .returning();
  if (redemption === undefined) {
    throw new Error('promo redemption insert failed');
  }

  return {
    redemption,
    promoCodeId: promo.id,
    companyId,
    ledgerEntryId: entry.id,
    redeemedByUserId,
  };
}
