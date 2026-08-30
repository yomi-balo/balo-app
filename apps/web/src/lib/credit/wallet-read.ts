import 'server-only';

import { cache } from 'react';

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
 * BAL-499 adds `resolveWalletAudience` (the shared capability + balance pair, `cache()`d per
 * request) and `loadTopBarWalletData` (the top-bar chip's leaner projection of the same read) —
 * see their docblocks below.
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
 * BAL-499 — THE ONE audience + balance read shared by BAL-402's dashboard card and BAL-499's
 * top-bar chip: one `MANAGE_BILLING` check + one wallet read. `cache()`d per REQUEST and keyed
 * on PRIMITIVES (`actorId: string, companyId: string`), so the layout's chip and the dashboard
 * page's card resolve to the same memo entry on a full `/dashboard` load and cost one pair of
 * round-trips between them — a `{ id }` object arg would miss on reference identity and
 * silently double the reads. (Outside a request — e.g. a plain unit test awaiting this directly
 * — `cache()` does not memoise; correctness is unaffected, only the dedupe. Precedent:
 * `session-sync.ts`, `derive-workspaces.ts`, `get-workspaces.ts`.)
 */
const resolveWalletAudience = cache(
  async (
    actorId: string,
    companyId: string
  ): Promise<{ readonly canManageBilling: boolean; readonly balanceMinor: number }> => {
    const [canManageBilling, wallet] = await Promise.all([
      hasCapability({ id: actorId }, CAPABILITIES.MANAGE_BILLING, { companyId }),
      creditWalletsRepository.findByCompanyId(companyId),
    ]);
    return { canManageBilling, balanceMinor: wallet?.balanceMinor ?? 0 };
  }
);

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
 *
 * BAL-499: the capability + balance pair is now `resolveWalletAudience` (shared with the top-bar
 * chip) — signature and returned union are unchanged; the existing tests are the
 * behaviour-preservation evidence.
 */
export async function loadDashboardWalletData(
  actor: { id: string },
  companyId: string
): Promise<DashboardWalletData> {
  // AUD buyer → no indicative FX (charged in their own currency); non-AUD → fetch the quote.
  const quote = resolveDisplayQuote(resolveBuyerCurrency());
  const [{ canManageBilling, balanceMinor }, fx] = await Promise.all([
    resolveWalletAudience(actor.id, companyId),
    quote ? resolveDisplayFx(quote) : Promise.resolve(null),
  ]);

  if (canManageBilling) {
    return { kind: 'holder', balanceMinor, fx };
  }

  const adminLabel = await resolveBillingAdminLabel(companyId);
  return { kind: 'member', balanceMinor, adminLabel };
}

/**
 * BAL-499 — the top-bar chip's projection: the same audience rule as the dashboard card, minus
 * the two reads the chip has no use for (the indicative FX quote and the billing-admin label).
 */
export interface TopBarWalletData {
  readonly balanceMinor: number;
  /** MANAGE_BILLING holder ⇒ the chip carries the inline "Top up" affordance. */
  readonly canTopUp: boolean;
}

/**
 * Resolve the top-bar credits chip's data for `actorId` within `companyId` (D8: the SAME
 * `MANAGE_BILLING` audience rule as `loadDashboardWalletData`, via the shared, request-`cache()`d
 * `resolveWalletAudience` — never a narrower policy invented for this nav ticket).
 *
 * ⚠ CALLER OBLIGATION: `companyId` MUST be a membership-derived session value (e.g.
 * `SessionUser.companyId`) — never caller-supplied / request-derived. This function returns
 * `balanceMinor` UNCONDITIONALLY; the capability check only decides `canTopUp`, so a
 * caller-supplied `companyId` would leak another company's balance to whoever can reach this
 * call. Safe today because the one caller (`credits-chip-slot.tsx`) passes the session's own
 * `companyId` — this note exists so the NEXT caller doesn't widen that.
 */
export async function loadTopBarWalletData(
  actorId: string,
  companyId: string
): Promise<TopBarWalletData> {
  const { canManageBilling, balanceMinor } = await resolveWalletAudience(actorId, companyId);
  return { balanceMinor, canTopUp: canManageBilling };
}
