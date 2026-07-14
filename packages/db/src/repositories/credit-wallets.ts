import { eq } from 'drizzle-orm';
import { db } from '../client';
import { creditWallets, type CreditWallet, type NewCreditWallet } from '../schema';

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
};
