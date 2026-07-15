import { db } from '../../client';
import { creditWallets } from '../../schema';
import type { CreditWallet, NewCreditWallet } from '../../schema';
import { companyFactory } from './company.factory';

interface CreditWalletFactoryOverrides {
  /** Reuse an existing company instead of seeding one. */
  companyId?: string;
  /** Row-level overrides (balanceMinor, lowBalanceMode, expiresAt, mandate, …). */
  values?: Partial<NewCreditWallet>;
}

export interface CreditWalletFactoryResult {
  wallet: CreditWallet;
  companyId: string;
}

/**
 * Seeds a `credit_wallets` row (BAL-376). Seeds a fresh company via `companyFactory`
 * when no `companyId` is passed (one wallet per company). Config columns fall to their
 * schema defaults unless overridden via `values` — e.g. `values: { balanceMinor: 50000 }`
 * to seed a starting balance for hold/available-balance tests (which do not assert
 * ledger reconciliation).
 */
export async function creditWalletFactory(
  overrides: CreditWalletFactoryOverrides = {}
): Promise<CreditWalletFactoryResult> {
  const companyId = overrides.companyId ?? (await companyFactory()).id;

  const [wallet] = await db
    .insert(creditWallets)
    .values({ companyId, ...overrides.values })
    .returning();
  if (wallet === undefined) {
    throw new Error('credit wallet insert failed');
  }

  return { wallet, companyId };
}
