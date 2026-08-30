import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { buildNavContext } from '@/lib/navigation/nav-context';
import { creditsChipIsInScope } from '@/components/layout/credits-chip-scope';
import { loadDashboardWalletData } from '@/lib/credit/wallet-read';
import { log } from '@/lib/logging';
import { CreditsSummary } from './_components/credits-summary';

/**
 * BAL-503 — Credits & billing. Reuses the existing `loadDashboardWalletData` helper (no new
 * read): it already runs the `MANAGE_BILLING` audience check via `hasCapability`, resolves the
 * balance + indicative display FX, is request-`cache()`d (shares reads with the top-bar credits
 * chip on the same request), and returns a projected, serialisable union — never the full wallet
 * row, so no Stripe customer / payment-method / mandate ref reaches the client bundle.
 *
 * `requireUser()`, not `getCurrentUser()` — this is a MONEY surface and its sibling
 * `billing/top-up/page.tsx` uses the same, which additionally refuses an un-onboarded actor
 * rather than delegating that half of the gate wholly to middleware.
 *
 * ⚠ WORKSPACE-SCOPED. `WalletWidget`'s own docblock declares "HARD BOUNDARY: client-lens only —
 * this never renders on an expert / payout lens", and `(dashboard)/layout.tsx` already suppresses
 * the top-bar credits chip outside a company workspace via this SAME predicate (BAL-499). Without
 * this gate an expert-workspace actor who typed the URL would render the widget and make that
 * comment false. Reuses `creditsChipIsInScope` — never a second definition of the scope rule.
 */
export default async function CreditsBillingPage(): Promise<React.JSX.Element> {
  const user = await requireUser();

  if (!creditsChipIsInScope(await buildNavContext(user))) {
    notFound();
  }

  try {
    const data = await loadDashboardWalletData({ id: user.id }, user.companyId);
    return (
      <div className="mx-auto max-w-3xl">
        <CreditsSummary data={data} />
      </div>
    );
  } catch (error) {
    log.error('Failed to load credits & billing settings', {
      userId: user.id,
      companyId: user.companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}
