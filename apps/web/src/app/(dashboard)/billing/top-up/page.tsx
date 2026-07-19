import {
  creditWalletsRepository,
  partyMembershipsRepository,
  usersRepository,
  fxDisplayRatesRepository,
} from '@balo/db';
import { isFxRateStale } from '@balo/shared/pricing';
import { requireUser, getCompanyContext } from '@/lib/auth/session';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { TopUpComposer } from '@/components/billing/top-up/TopUpComposer';
import { MemberWalletNudge } from '@/components/billing/top-up/MemberWalletNudge';
import type { DisplayFxSnapshot, WalletSnapshot } from '@/components/billing/top-up/types';
import type { DisplayCurrency } from '@/lib/credit/display-constants';
import { resolveBuyerCurrency, resolveDisplayQuote } from '@/lib/credit/display-fx';

/**
 * BAL-377 top-up route (ADR-1040 Lane 1). Capability-gated: a MANAGE_BILLING holder gets the
 * composer; any other company member gets the member-variant nudge surface (design "never
 * sees this screen"). Server Component — resolves session + wallet + display-FX and passes
 * only projected, serialisable snapshots to the client (never the full wallet row → no Stripe
 * customer / payment-method / mandate-ref secrets reach the client bundle).
 */

/**
 * Resolve the presentation-only display-FX snapshot for a specific indicative quote (null when
 * missing or stale). Only called when the buyer is NOT an AUD buyer — an AUD buyer is charged
 * in their own currency, so the indicative is hidden entirely (see `resolveDisplayQuote`).
 */
async function resolveDisplayFx(quote: DisplayCurrency): Promise<DisplayFxSnapshot | null> {
  const rate = await fxDisplayRatesRepository.getLatest(quote);
  if (rate === undefined || isFxRateStale(rate.asOf, new Date())) {
    return null;
  }
  const audToQuote = Number(rate.rate);
  if (!Number.isFinite(audToQuote) || audToQuote <= 0) {
    return null;
  }
  return { currency: quote, audToQuote };
}

/** The first billing holder's display name for the member nudge copy (warm generic fallback). */
async function resolveBillingAdminLabel(companyId: string): Promise<string> {
  const billingUserIds = await partyMembershipsRepository.listBillingUserIds(companyId);
  const [firstId] = billingUserIds;
  if (firstId === undefined) return 'your billing admin';
  const admin = await usersRepository.findById(firstId);
  const name = [admin?.firstName, admin?.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : 'your billing admin';
}

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

  if (wallet === undefined) {
    return (
      <div className={shell}>
        <div className="border-border bg-card text-muted-foreground w-full max-w-[540px] rounded-2xl border p-8 text-sm shadow-sm">
          We&apos;re setting up your team&apos;s balance. Please refresh in a moment.
        </div>
      </div>
    );
  }

  const snapshot: WalletSnapshot = {
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
