import type { DisplayCurrency } from './display-constants';

/**
 * BAL-377 — buyer-currency resolution for the presentation-only indicative FX ("≈ local").
 *
 * The wallet is ALWAYS charged in AUD at face value (the locked funding decision). The "≈
 * local currency" figure is a courtesy estimate of what that AUD roughly costs in the buyer's
 * OWN currency — so it is only meaningful when the buyer is NOT already an AUD buyer. Showing
 * "≈ US$…" to an Australian buyer (whose currency IS the charge currency) is wrong and was the
 * bug this module fixes: the quote was hardcoded to USD for every region.
 *
 * There is no per-company region signal in the schema yet (companies carry no country /
 * currency column), so we default to the platform home market — AUD — for which no indicative
 * is shown. Full region localisation (USD / GBP / EUR from a real region signal) is a
 * deliberate follow-up; until then we NEVER assume a foreign currency and mis-label the charge.
 */

/** The buyer's home currency — AUD (home market) plus the localisable display quotes. */
export type BuyerCurrency = DisplayCurrency | 'AUD';

/**
 * Resolve the buyer's home currency. Defaults to AUD (no region signal exists yet); a
 * follow-up will derive USD/GBP/EUR from a real company/region signal.
 */
export function resolveBuyerCurrency(): BuyerCurrency {
  return 'AUD';
}

/**
 * The indicative display quote to fetch, or `null` when the buyer is charged in their own
 * currency (AUD). A `null` quote hides the "≈ local" indicative everywhere (hero + footer) and
 * renders the honest AUD line instead — the AUD + time figures never depend on FX.
 */
export function resolveDisplayQuote(buyerCurrency: BuyerCurrency): DisplayCurrency | null {
  return buyerCurrency === 'AUD' ? null : buyerCurrency;
}
