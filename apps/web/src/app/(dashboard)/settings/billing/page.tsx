import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { buildNavContext } from '@/lib/navigation/nav-context';
import { creditsChipIsInScope } from '@/components/layout/credits-chip-scope';
import { loadBillingSettingsWallet, loadDashboardWalletData } from '@/lib/credit/wallet-read';
import { log } from '@/lib/logging';
import { CreditsSummary } from './_components/credits-summary';
import { BillingSettingsSections } from './_components/billing-settings-sections';

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
 *
 * BAL-516 EXTENSION — adds `loadBillingSettingsWallet` (the SAME `MANAGE_BILLING`-gated,
 * request-`cache()`d audience read `loadDashboardWalletData` uses, so a single request costs one
 * `hasCapability` + one `findByCompanyId` total across both reads) fetched in `Promise.all` inside
 * this SAME `try/catch` — a failure of either fails the whole page, matching current behaviour
 * (the balance and the new sections come from the same request). A non-`null` snapshot renders
 * `<BillingSettingsSections>` under `<CreditsSummary>`; `null` (a non-holder) renders nothing
 * extra — not a differently-styled empty state, the sections are simply absent, exactly like
 * `CreditsSummary`'s own member branch. BAL-503 decision **O1 still holds: the top-up composer is
 * NOT duplicated or moved here** — this only adds the standing-preference controls (low-balance
 * mode/band, saved card), never a purchase flow.
 */
export default async function CreditsBillingPage(): Promise<React.JSX.Element> {
  const user = await requireUser();

  if (!creditsChipIsInScope(await buildNavContext(user))) {
    notFound();
  }

  try {
    const [data, billingSettings] = await Promise.all([
      loadDashboardWalletData({ id: user.id }, user.companyId),
      loadBillingSettingsWallet({ id: user.id }, user.companyId),
    ]);
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <CreditsSummary data={data} />
        {billingSettings !== null && (
          // FIX ROUND 2 (review NEW-1 — REGRESSION) — keyed to the owning COMPANY, not the
          // wallet id: `wallet.walletId` is `null` for an unprovisioned wallet, so two
          // unprovisioned companies would otherwise share a key. `BillingSettingsSections` seeds
          // `savedConfig` from `wallet` ONCE at mount and never re-seeds it (by design, so an
          // in-session Save/reconcile isn't clobbered by an unrelated refresh — see that
          // component's docblock). The workspace switcher is a bare `router.refresh()` on this
          // SAME route (`use-workspace-switch.ts`), so without this key React reconciles the
          // coordinator IN PLACE across a switch and `savedConfig` — plus `cardRemoved` and
          // `skipNextWalletUpdateRef` — survive into a DIFFERENT company's wallet, silently
          // reintroducing the stale-consent defect F1 closed (a different company's remove
          // dialog could render the wrong mode-consequence branch). Keying forces a remount,
          // which reseeds every one of those from the fresh `wallet` prop.
          <BillingSettingsSections
            key={user.companyId}
            wallet={billingSettings.wallet}
            billingEmail={billingSettings.billingEmail}
          />
        )}
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
