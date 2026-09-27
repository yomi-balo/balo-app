import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
import { formatAudMinor, formatAudWholeDollars } from './credit-format.js';
import { formatAsOfUtc } from './format-as-of.js';

/**
 * The dated top-up figure a balance notice quotes — the dunning notice, and the two balance arms
 * of `booking.funding_blocked` (an account on hold, credit set aside for planned consultations).
 * Defined ONCE here so the email and in-app channels can never disagree on what counts as a
 * figure, on the "as of" label, or on where the "top-ups totalling" wording starts.
 *
 * Presentation only — nothing here touches balance or settlement math.
 */
export interface TopUpFigure {
  /** The top-up, formatted — `A$275.00`. Never a zero: see `buildTopUpFigure`. */
  readonly amount: string;
  /** The instant the figure was read — `2:05 pm UTC, 23 September 2026`. */
  readonly asOf: string;
  /** The figure is above the top-up page's per-top-up maximum, so it takes several top-ups. */
  readonly exceedsSingleTopUp: boolean;
  /** The per-top-up maximum, in WHOLE dollars — `A$10,000`, never `A$10,000.00`. */
  readonly maxTopUp: string;
}

/**
 * The figure for a `topUpNeededMinor` and its `asOfIso`, or `null` when there is none to quote.
 *
 * ⚠ A zero, negative or non-finite amount — or a missing instant — is `null`, NEVER a figure: a
 * notice must not render `A$0.00`, and a figure with no date could be read hours late with
 * nothing to say when it was true. Each caller chooses what "no figure" means for its own copy
 * (the hold arm's failed-heal fallback; the dunning notice, which the publisher never sends
 * without one).
 */
export function buildTopUpFigure(topUpNeededMinor: number, asOfIso: unknown): TopUpFigure | null {
  if (!Number.isFinite(topUpNeededMinor) || topUpNeededMinor <= 0) {
    return null;
  }
  if (typeof asOfIso !== 'string' || asOfIso.length === 0) {
    return null;
  }
  return {
    amount: formatAudMinor(topUpNeededMinor),
    asOf: formatAsOfUtc(asOfIso),
    exceedsSingleTopUp: topUpNeededMinor > TOP_UP_LIMITS_MINOR.max,
    maxTopUp: formatAudWholeDollars(TOP_UP_LIMITS_MINOR.max),
  };
}

/** What a notice calls the paying company when its name did not resolve. */
export const FALLBACK_COMPANY_LABEL = 'your team';

/**
 * The company name off the resolver's `data.company` hydration (`{ name }`, or `null` /
 * `undefined` when the company is gone), or `null` when there is no usable name.
 */
export function readCompanyName(company: unknown): string | null {
  if (typeof company !== 'object' || company === null || !('name' in company)) {
    return null;
  }
  const { name } = company;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
}

/** The company as a mid-sentence label: its name, else "your team". */
export function companyLabelFor(name: string | null): string {
  return name ?? FALLBACK_COMPANY_LABEL;
}

/**
 * The company as the FIRST words of a sentence or subject: its name, else "Your team". Only the
 * fallback is capitalised — a real name ("eBay") is never re-cased.
 */
export function companyLabelAtStart(name: string | null): string {
  return name ?? 'Your team';
}

/**
 * A top-up as a noun phrase, in the singular or — above the top-up page's per-top-up maximum — the
 * "top-ups totalling" wording: `a top-up of A$275.00 or more` / `top-ups totalling A$12,000.00 or
 * more`. "Or more" is on every figure: it is true at any figure and promises no exact amount.
 */
export function topUpPhrase(figure: TopUpFigure): string {
  return figure.exceedsSingleTopUp
    ? `top-ups totalling ${figure.amount} or more`
    : `a top-up of ${figure.amount} or more`;
}

/** Capitalise the first character of one of this module's own fixed phrases. */
export function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * How a `booking.funding_blocked` notice reads, decided once and shared by the email and in-app
 * channels. A discriminated union so each arm carries exactly the data its copy quotes:
 *
 * - `unfunded` — BAL-478's arm: no mandate and not enough credit. No figure, ever.
 * - `hold` — an open receivable is holding the account; the figure is the top-up that clears it.
 * - `hold_fallback` — the hold's debt is already covered but the booking API could not clear it,
 *   so there is NO figure to quote (never `A$0.00`).
 * - `reserved` — part of the credit is set aside for planned consultations; the figure is the
 *   top-up that would make room, `count` is how many planned consultations hold the credit.
 */
export type FundingBlockNotice =
  | { readonly variant: 'unfunded' }
  | { readonly variant: 'hold_fallback' }
  | { readonly variant: 'hold'; readonly figure: TopUpFigure }
  | { readonly variant: 'reserved'; readonly figure: TopUpFigure; readonly count: number };

/**
 * Resolve a payload's block kind, raw top-up figure and reserved count into the notice arm. The
 * figure is built here, from `topUpNeededMinor` + `asOfIso`, so the hold arm can tell "there is no
 * figure to quote" apart from "there is one, but it could not be dated".
 *
 * - `account_on_hold` with a figure → `hold`. With no positive `topUpNeededMinor` (absent or zero)
 *   → `hold_fallback`, the only case where "the balance already covered it" is what the payload
 *   says. With a positive `topUpNeededMinor` but no usable `asOfIso` the payload is malformed and
 *   the balance may NOT be covered, so it degrades to `unfunded` — never to that claim.
 * - `reserved_by_upcoming` needs a figure AND a count. The publish route rejects a payload missing
 *   either, so one reaching a template is a contract break; rather than invent a figure-less
 *   reserved sentence it degrades to `unfunded`.
 * - Anything else, including no `blockKind` at all (a pre-BAL-474 unfunded refusal), is
 *   `unfunded`: its copy ("a payment method on file, or enough credit to cover it") is still true
 *   of a refusal for lack of credit and quotes nothing.
 */
export function resolveFundingBlockNotice(
  blockKind: unknown,
  topUpNeededMinor: number,
  asOfIso: unknown,
  reservedCount: number
): FundingBlockNotice {
  const figure = buildTopUpFigure(topUpNeededMinor, asOfIso);
  if (blockKind === 'account_on_hold') {
    if (figure !== null) {
      return { variant: 'hold', figure };
    }
    const hasNoFigureToQuote = !Number.isFinite(topUpNeededMinor) || topUpNeededMinor <= 0;
    return hasNoFigureToQuote ? { variant: 'hold_fallback' } : { variant: 'unfunded' };
  }
  if (blockKind === 'reserved_by_upcoming' && figure !== null && reservedCount > 0) {
    return { variant: 'reserved', figure, count: reservedCount };
  }
  return { variant: 'unfunded' };
}
