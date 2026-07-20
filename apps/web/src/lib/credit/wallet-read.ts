import 'server-only';

import {
  creditWalletsRepository,
  fxDisplayRatesRepository,
  partyMembershipsRepository,
  usersRepository,
} from '@balo/db';
import { isFxRateStale } from '@balo/shared/pricing';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { resolveBuyerCurrency, resolveDisplayQuote } from '@/lib/credit/display-fx';
import type { DisplayCurrency } from '@/lib/credit/display-constants';
import type { DisplayFxSnapshot } from '@/components/billing/top-up/types';

/**
 * BAL-402 — SERVER-ONLY shared wallet reads for the client-lens credit surfaces (ADR-1040).
 * Hosts the two helpers formerly inlined in the top-up page (`resolveDisplayFx`,
 * `resolveBillingAdminLabel`) so the top-up route and the dashboard slot share one source of
 * truth (no Sonar new-code duplication), plus `loadDashboardWalletData` which resolves the
 * capability lens + balance + indicative FX into a projected, serialisable union.
 *
 * `import 'server-only'`: every helper touches `@balo/db` / the `server-only` authz gate, so
 * this module must never reach a client bundle. Consumers cross the boundary with the projected
 * union below — never the full wallet row (no Stripe customer / payment-method / mandate-ref
 * secrets, and never `balo_fee_bps` / margin, leak to the client).
 */

/**
 * Resolve the presentation-only display-FX snapshot for a specific indicative quote (null when
 * the rate is missing OR stale — the two are indistinguishable to the caller, which simply omits
 * the "≈ local" secondary line). Only called when the buyer is NOT an AUD buyer — an AUD buyer is
 * charged in their own currency, so the indicative is hidden entirely (see `resolveDisplayQuote`).
 */
export async function resolveDisplayFx(quote: DisplayCurrency): Promise<DisplayFxSnapshot | null> {
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
export async function resolveBillingAdminLabel(companyId: string): Promise<string> {
  const billingUserIds = await partyMembershipsRepository.listBillingUserIds(companyId);
  const [firstId] = billingUserIds;
  if (firstId === undefined) return 'your billing admin';
  const admin = await usersRepository.findById(firstId);
  const name = [admin?.firstName, admin?.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : 'your billing admin';
}

/**
 * The projected, serialisable wallet read for the dashboard card — a discriminated union keyed
 * on the capability lens (ADR-1029: resolved via `hasCapability`, never `role ===` / `activeMode
 * ===`). The `holder` branch carries the indicative FX (inert `null` today — AUD buyer); the
 * `member` branch carries the resolved billing-admin label and always renders `fx=null`.
 */
export type DashboardWalletData =
  | { kind: 'holder'; balanceMinor: number; fx: DisplayFxSnapshot | null }
  | { kind: 'member'; balanceMinor: number; adminLabel: string };

/**
 * Resolve the dashboard wallet card's data for `actor` within `companyId`: the capability lens,
 * the AUD-minor balance (defaulting to `0` when no wallet is provisioned yet — which drives the
 * correct top-up invitation on both lenses), and the indicative FX (always `null` today, since
 * `resolveBuyerCurrency()` is hardcoded AUD). Never returns the full wallet row.
 */
export async function loadDashboardWalletData(
  actor: { id: string },
  companyId: string
): Promise<DashboardWalletData> {
  // AUD buyer → no indicative FX (charged in their own currency); non-AUD → fetch the quote.
  const quote = resolveDisplayQuote(resolveBuyerCurrency());
  const [canManageBilling, wallet, fx] = await Promise.all([
    hasCapability(actor, CAPABILITIES.MANAGE_BILLING, { companyId }),
    creditWalletsRepository.findByCompanyId(companyId),
    quote ? resolveDisplayFx(quote) : Promise.resolve(null),
  ]);

  const balanceMinor = wallet?.balanceMinor ?? 0;
  if (canManageBilling) {
    return { kind: 'holder', balanceMinor, fx };
  }

  const adminLabel = await resolveBillingAdminLabel(companyId);
  return { kind: 'member', balanceMinor, adminLabel };
}
