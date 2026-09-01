import { creditWalletsRepository } from '@balo/db';
import { requireUser, getCompanyContext } from '@/lib/auth/session';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { TopUpComposer } from '@/components/billing/top-up/TopUpComposer';
import { MemberWalletNudge } from '@/components/billing/top-up/MemberWalletNudge';
import type { WalletSnapshot } from '@/components/billing/top-up/types';
import { resolveBuyerCurrency, resolveDisplayQuote } from '@/lib/credit/display-fx';
import { resolveDisplayFx, resolveBillingAdminLabel } from '@/lib/credit/wallet-read';
import { DEFAULT_TOPUP_RELOAD_MINOR, DEFAULT_TOPUP_THRESHOLD_MINOR } from '@balo/shared/pricing';

/**
 * BAL-377 top-up route (ADR-1040 Lane 1). Capability-gated: a MANAGE_BILLING holder gets the
 * composer; any other company member gets the member-variant nudge surface (design "never
 * sees this screen"). Server Component — resolves session + wallet + display-FX and passes
 * only projected, serialisable snapshots to the client (never the full wallet row → no Stripe
 * customer / payment-method / mandate-ref secrets reach the client bundle).
 */

/**
 * The projection for a company that has never held credit. Its `credit_wallets` row does not
 * exist yet, which is a normal resting state — NOT an error and NOT a transient setup step
 * (nothing provisions on render; the row is materialised by the first money event, when
 * `startPurchaseAction` calls `ensureForCompany`). The figures below mirror the schema
 * defaults on `credit_wallets`, so what the buyer configures against here is exactly what the
 * row will be created holding.
 */
const UNPROVISIONED_WALLET: WalletSnapshot = {
  walletId: null,
  balanceMinor: 0,
  lowBalanceMode: 'notify_only',
  hasCard: false,
  topupReloadMinor: DEFAULT_TOPUP_RELOAD_MINOR,
  topupThresholdMinor: DEFAULT_TOPUP_THRESHOLD_MINOR,
};

export default async function TopUpPage() {
  const user = await requireUser();
  const { companyId } = await getCompanyContext();

  // AUD buyer → no indicative FX (charged in their own currency); non-AUD → fetch the quote.
  const quote = resolveDisplayQuote(resolveBuyerCurrency());
  const [canManageBilling, wallet, fx] = await Promise.all([
    hasCapability(user, CAPABILITIES.MANAGE_BILLING, { companyId }),
    creditWalletsRepository.findByCompanyId(companyId),
    quote ? resolveDisplayFx(quote) : Promise.resolve(null),
  ]);

  const shell = 'flex min-h-[80vh] items-start justify-center px-4 py-10';

  if (!canManageBilling) {
    const adminLabel = await resolveBillingAdminLabel(companyId);
    return (
      <div className={shell}>
        <MemberWalletNudge
          balanceMinor={wallet?.balanceMinor ?? 0}
          adminLabel={adminLabel}
          fx={fx}
        />
      </div>
    );
  }

  const snapshot: WalletSnapshot =
    wallet === undefined
      ? UNPROVISIONED_WALLET
      : {
          walletId: wallet.id,
          balanceMinor: wallet.balanceMinor,
          lowBalanceMode: wallet.lowBalanceMode,
          hasCard: wallet.mandateStatus === 'active',
          topupReloadMinor: wallet.topupReloadMinor,
          topupThresholdMinor: wallet.topupThresholdMinor,
        };

  return (
    <div className={shell}>
      <TopUpComposer wallet={snapshot} fx={fx} />
    </div>
  );
}
