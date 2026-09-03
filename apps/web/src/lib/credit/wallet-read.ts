import 'server-only';

import { cache } from 'react';

import {
  creditWalletsRepository,
  fxDisplayRatesRepository,
  partyMembershipsRepository,
  usersRepository,
  type CreditWallet,
} from '@balo/db';
import {
  isFxRateStale,
  DEFAULT_TOPUP_RELOAD_MINOR,
  DEFAULT_TOPUP_THRESHOLD_MINOR,
} from '@balo/shared/pricing';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { resolveBuyerCurrency, resolveDisplayQuote } from '@/lib/credit/display-fx';
import type { DisplayCurrency } from '@/lib/credit/display-constants';
import type {
  DisplayFxSnapshot,
  SavedCard,
  WalletSnapshot,
} from '@/components/billing/top-up/types';

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
 *
 * BAL-516 widens the return to also carry the raw `wallet` row (`undefined` when unprovisioned),
 * so `loadBillingSettingsWallet` below shares this SAME cached call rather than issuing a second
 * `findByCompanyId` on a `/settings/billing` request — one `hasCapability` + one `findByCompanyId`
 * between the top-bar chip, the dashboard card, and this read. `loadDashboardWalletData` /
 * `loadTopBarWalletData` simply destructure the two fields they already used; neither signature
 * changes. The raw row rides only inside this server-only module — every export still projects.
 */
const resolveWalletAudience = cache(
  async (
    actorId: string,
    companyId: string
  ): Promise<{
    readonly canManageBilling: boolean;
    readonly balanceMinor: number;
    readonly wallet: CreditWallet | undefined;
  }> => {
    const [canManageBilling, wallet] = await Promise.all([
      hasCapability({ id: actorId }, CAPABILITIES.MANAGE_BILLING, { companyId }),
      creditWalletsRepository.findByCompanyId(companyId),
    ]);
    return { canManageBilling, balanceMinor: wallet?.balanceMinor ?? 0, wallet };
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

// ── BAL-516: shared saved-card / wallet-snapshot projection + the settings page's read ──────

/**
 * The projection for a company that has never held credit. Its `credit_wallets` row does not
 * exist yet, which is a normal resting state — NOT an error and NOT a transient setup step
 * (nothing provisions on render; the row is materialised by the first money event, when
 * `ensureWallet`/`ensureForCompany` runs). The figures below mirror the schema defaults on
 * `credit_wallets`, so what a client configures against here is exactly what the row will be
 * created holding.
 *
 * BAL-516 — moved here VERBATIM from `billing/top-up/page.tsx` (was a local `const`) so both
 * that page and `loadBillingSettingsWallet` share ONE definition; copying it would be a second
 * statement of the schema defaults that could silently drift from them.
 */
export const UNPROVISIONED_WALLET: WalletSnapshot = {
  walletId: null,
  balanceMinor: 0,
  lowBalanceMode: 'notify_only',
  savedCard: null,
  topupReloadMinor: DEFAULT_TOPUP_RELOAD_MINOR,
  topupThresholdMinor: DEFAULT_TOPUP_THRESHOLD_MINOR,
};

/**
 * Project the wallet's saved card for display, or `null`.
 *
 * ⚠ THE STRIPE-ID CONDITIONS ARE NOT REDUNDANT. A row can carry display columns while the
 * payment-method id is gone (detached in the Stripe dashboard, a partial state we do not
 * create but must not render). Such a card cannot actually be charged, so it must not offer a
 * saved-card row — this mirrors `isWalletCardReusableOnSession`, evaluated where the projection
 * is built. The four display columns move together by CHECK constraint, so testing `cardBrand`
 * alone would be enough for THEM; each is still narrowed because TypeScript needs it.
 *
 * `mandateActive` is the WEAKER/STRONGER distinction made explicit: the card being present says
 * Balo may charge it while the buyer watches; only `mandate_status === 'active'` says Balo may
 * charge it unattended.
 *
 * BAL-516 — moved here VERBATIM from `billing/top-up/page.tsx` (was a local, unexported
 * function) so the settings read can share it rather than re-stating "is this card
 * chargeable" a second time (a Sonar duplication hit, and a second copy of a consent-adjacent
 * rule to keep in sync).
 */
export function projectSavedCard(wallet: {
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  stripeCustomerId: string | null;
  stripePaymentMethodId: string | null;
  mandateStatus: string | null;
}): SavedCard | null {
  const { cardBrand, cardLast4, cardExpMonth, cardExpYear } = wallet;
  if (
    cardBrand === null ||
    cardLast4 === null ||
    cardExpMonth === null ||
    cardExpYear === null ||
    wallet.stripeCustomerId === null ||
    wallet.stripePaymentMethodId === null
  ) {
    return null;
  }
  return {
    brand: cardBrand,
    last4: cardLast4,
    expMonth: cardExpMonth,
    expYear: cardExpYear,
    mandateActive: wallet.mandateStatus === 'active',
  };
}

/**
 * Project a full `CreditWallet` row into the serialisable {@link WalletSnapshot} both
 * `billing/top-up/page.tsx` and `/settings/billing` hand to their client trees. The single
 * shared call site for "what does the client tree need to know about this wallet" — never the
 * full row (no Stripe customer / payment-method / mandate-ref secrets reach the client bundle).
 */
export function projectWalletSnapshot(wallet: CreditWallet): WalletSnapshot {
  return {
    walletId: wallet.id,
    balanceMinor: wallet.balanceMinor,
    lowBalanceMode: wallet.lowBalanceMode,
    savedCard: projectSavedCard(wallet),
    topupReloadMinor: wallet.topupReloadMinor,
    topupThresholdMinor: wallet.topupThresholdMinor,
  };
}

/**
 * BAL-516 — the settings page's snapshot read for sections 2–3 ("When your balance runs low" /
 * "Payment method"). Same `MANAGE_BILLING` audience rule as `loadDashboardWalletData`
 * (`hasCapability`, never role/activeMode) via the SAME request-`cache()`d
 * `resolveWalletAudience` — a `/settings/billing` request costs one `hasCapability` + one
 * `findByCompanyId` total across the top-bar chip, `CreditsSummary`, and this read.
 *
 * `null` = not a `MANAGE_BILLING` holder (the sections simply do not render — not an empty
 * state). Holder with no wallet row yet ⇒ {@link UNPROVISIONED_WALLET} (Save/Add provisions it
 * via `ensureWallet`, unchanged). Holder with a row ⇒ `projectWalletSnapshot(wallet)`. Returns
 * the projected snapshot only — never the full wallet row.
 */
export async function loadBillingSettingsWallet(
  actor: { id: string },
  companyId: string
): Promise<WalletSnapshot | null> {
  const { canManageBilling, wallet } = await resolveWalletAudience(actor.id, companyId);
  if (!canManageBilling) {
    return null;
  }
  return wallet === undefined ? UNPROVISIONED_WALLET : projectWalletSnapshot(wallet);
}
