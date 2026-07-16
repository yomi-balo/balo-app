import { and, asc, eq, gt, isNotNull, lte } from 'drizzle-orm';
import { db } from '../client';
import {
  creditWallets,
  type CreditWallet,
  type MandateStatus,
  type NewCreditWallet,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/** Config fields a MANAGE_BILLING-gated action may write (gating lives at the caller). */
interface UpdateWalletConfigInput {
  lowBalanceMode?: CreditWallet['lowBalanceMode'];
  topupThresholdMinor?: number;
  topupReloadMinor?: number;
  /** Nullable: pass `null` to clear back to the platform default read at the caller. */
  overdraftCeilingMinor?: number | null;
  /** Nullable: off-session mandate secrets (card-funded). */
  stripePaymentMethodId?: string | null;
  mandateRef?: string | null;
}

export const creditWalletsRepository = {
  /**
   * Create the single wallet for a company. Config columns fall to their schema
   * defaults (`balance_minor` 0, `low_balance_mode` 'notify_only', threshold/reload
   * $20/$100). Raw unique violation (23505) if a wallet already exists for the company
   * (the `credit_wallets_company_idx` guarantees one-per-company).
   */
  async create(input: { companyId: string }): Promise<CreditWallet> {
    const [row] = await db.insert(creditWallets).values({ companyId: input.companyId }).returning();
    if (row === undefined) {
      throw new Error('Failed to create credit wallet');
    }
    return row;
  },

  /** Wallet by id (no soft-delete on this table). */
  async findById(id: string): Promise<CreditWallet | undefined> {
    return db.query.creditWallets.findFirst({ where: eq(creditWallets.id, id) });
  },

  /** The one wallet for a company (rides `credit_wallets_company_idx`). */
  async findByCompanyId(companyId: string): Promise<CreditWallet | undefined> {
    return db.query.creditWallets.findFirst({
      where: eq(creditWallets.companyId, companyId),
    });
  },

  /**
   * Wallets whose rolling dormancy expiry has been reached and still hold a positive
   * balance — the eligibility set for the daily expiry sweep (BAL-380). Filters
   * `expires_at IS NOT NULL AND expires_at <= now AND balance_minor > 0`, oldest expiry
   * first. Returns FULL rows (server-side job use only — the sweep needs `id`,
   * `companyId`, `balanceMinor`, `expiresAt`). Each returned wallet is then re-read under
   * the advisory lock in `expireDormantBalance` before any write (the top-up race guard).
   * `credit_wallets` has NO `deleted_at`, so there is no soft-delete filter.
   */
  async findExpirableWallets(now: Date): Promise<CreditWallet[]> {
    return db
      .select()
      .from(creditWallets)
      .where(
        and(
          isNotNull(creditWallets.expiresAt),
          lte(creditWallets.expiresAt, now),
          gt(creditWallets.balanceMinor, 0)
        )
      )
      .orderBy(asc(creditWallets.expiresAt));
  },

  /**
   * Wallets whose rolling dormancy expiry falls in the half-open band `(after, until]`
   * and still hold a positive balance — the pre-expiry reminder set for the daily sweep
   * (BAL-380). The 60d/30d reminder bands map to `(now+59d, now+60d]` / `(now+29d, now+30d]`;
   * the half-open interval (strictly `> after`, `<= until`) makes adjacent daily bands
   * partition cleanly so a wallet crosses each band on exactly one tick. `NULL` expiries
   * are excluded by construction (`NULL > after` is unknown). Oldest expiry first.
   */
  async findWalletsExpiringBetween(after: Date, until: Date): Promise<CreditWallet[]> {
    return db
      .select()
      .from(creditWallets)
      .where(
        and(
          gt(creditWallets.expiresAt, after),
          lte(creditWallets.expiresAt, until),
          gt(creditWallets.balanceMinor, 0)
        )
      )
      .orderBy(asc(creditWallets.expiresAt));
  },

  /**
   * Write wallet config (the data plane for the later MANAGE_BILLING-gated actions —
   * NO gating here, the caller resolves the capability). Only the provided fields are
   * written; `overdraftCeilingMinor`/`stripePaymentMethodId`/`mandateRef` accept an
   * explicit `null` to clear. Throws if the wallet is missing.
   */
  async updateConfig(id: string, input: UpdateWalletConfigInput): Promise<CreditWallet> {
    const set: Partial<NewCreditWallet> = {};
    if (input.lowBalanceMode !== undefined) set.lowBalanceMode = input.lowBalanceMode;
    if (input.topupThresholdMinor !== undefined)
      set.topupThresholdMinor = input.topupThresholdMinor;
    if (input.topupReloadMinor !== undefined) set.topupReloadMinor = input.topupReloadMinor;
    if (input.overdraftCeilingMinor !== undefined)
      set.overdraftCeilingMinor = input.overdraftCeilingMinor;
    if (input.stripePaymentMethodId !== undefined)
      set.stripePaymentMethodId = input.stripePaymentMethodId;
    if (input.mandateRef !== undefined) set.mandateRef = input.mandateRef;

    // Nothing to write → return the current row (a bare `.set({})` would error).
    if (Object.keys(set).length === 0) {
      const current = await db.query.creditWallets.findFirst({ where: eq(creditWallets.id, id) });
      if (current === undefined) {
        throw new Error(`Credit wallet not found: ${id}`);
      }
      return current;
    }

    const [row] = await db
      .update(creditWallets)
      .set(set)
      .where(eq(creditWallets.id, id))
      .returning();
    if (row === undefined) {
      throw new Error(`Credit wallet not found: ${id}`);
    }
    return row;
  },

  /**
   * Persist an ACTIVE off-session mandate on the wallet (BAL-382) — customer +
   * payment-method + mandate ref + `mandate_status='active'`, in ONE write. Tx-composable
   * via `DbExecutor` (pass the webhook's `tx` so it commits with the marker + effect;
   * mirrors `auditEventsRepository.record`). Written on `setup_intent.succeeded`. Throws
   * if the wallet is missing.
   */
  async applyMandate(
    exec: DbExecutor,
    input: {
      walletId: string;
      stripeCustomerId: string;
      stripePaymentMethodId: string;
      mandateRef: string;
      mandateStatus: 'active';
    }
  ): Promise<CreditWallet> {
    const [row] = await exec
      .update(creditWallets)
      .set({
        stripeCustomerId: input.stripeCustomerId,
        stripePaymentMethodId: input.stripePaymentMethodId,
        mandateRef: input.mandateRef,
        mandateStatus: input.mandateStatus,
      })
      .where(eq(creditWallets.id, input.walletId))
      .returning();
    if (row === undefined) {
      throw new Error(`Credit wallet not found: ${input.walletId}`);
    }
    return row;
  },

  /**
   * Flip only the mandate lifecycle status (BAL-382) — e.g. `pending` on
   * `createSetupIntent`, `failed` on `setup_intent.setup_failed`. Tx-composable via
   * `DbExecutor`. Does NOT touch the customer / payment-method / mandate-ref columns.
   * Throws if the wallet is missing.
   */
  async applyMandateStatus(
    exec: DbExecutor,
    walletId: string,
    status: MandateStatus
  ): Promise<CreditWallet> {
    const [row] = await exec
      .update(creditWallets)
      .set({ mandateStatus: status })
      .where(eq(creditWallets.id, walletId))
      .returning();
    if (row === undefined) {
      throw new Error(`Credit wallet not found: ${walletId}`);
    }
    return row;
  },
};
