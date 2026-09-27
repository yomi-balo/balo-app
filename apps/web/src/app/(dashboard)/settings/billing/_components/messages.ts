import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
import { formatAud, upcomingConsultationsLabel } from '@/lib/credit/display-constants';

/**
 * BAL-526 (D2) — the one `UNCONFIGURED_MESSAGE` literal shared, byte-identical, by
 * `payment-method-manager.tsx` and `card-capture-panel.tsx`. Both surfaces show this when
 * `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is unset.
 *
 * Pure string constant — safe for both `'use client'` modules to import directly. (The module's
 * only imports are two pure, client-safe helpers used by the BAL-474 D10.6 copy below.)
 */
export const STRIPE_UNCONFIGURED_MESSAGE =
  "Card payments aren't configured right now. Please try again later.";

/**
 * BAL-529 M3 — the reason attached to the DISABLED "Change" control when
 * `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is unset. Deliberately SHORT and non-duplicative:
 * `STRIPE_UNCONFIGURED_MESSAGE` above already explains WHY, at the top of the same section. This
 * says WHAT, attached to the control — which is the whole point for a screen-reader user who
 * tabs straight to it and never hears the section paragraph.
 *
 * FIX ROUND 1 F6 (UX U1) — a disabled control is out of the Tab order, so the only AT users who
 * reach it are BROWSE/VIRTUAL-CURSOR users, not Tab users — and that population will NOT have
 * heard `STRIPE_UNCONFIGURED_MESSAGE`'s "Please try again later" either, so the "non-duplicative"
 * reasoning above still held but left this string a dead end for exactly the audience it exists
 * for. Mirrors `STRIPE_UNCONFIGURED_MESSAGE`'s closing clause verbatim rather than inventing new
 * language.
 */
export const CHANGE_CARD_DISABLED_REASON =
  "Changing your card isn't available right now — please try again later.";

/**
 * BAL-474 owner ruling D10.6 — the remove-card dialog's blocking copy when the card is backing
 * upcoming Case bookings the company's credit does not cover. OWNER-APPROVED VERBATIM (Yomi,
 * 2026-09-25): a change to any character needs the owner again. Pinned against the full literals
 * in `messages.test.ts`.
 *
 *  - `{count}`   — "1 upcoming consultation" / "{n} upcoming consultations";
 *  - `{Company}` — "{Name}'s", or "your team's" when there is no name (copy v2.1; the same
 *                  spelling and straight apostrophe the booking balance panel uses);
 *  - `{amount}`  — the top-up figure WITH cents, `A$1,234.50`: exactly what the booking balance
 *                  panel prints from the same `topUpNeededMinor` (`formatAud`, no rounding), so
 *                  the two surfaces agree;
 *  - the `large` arm applies when the figure exceeds `TOP_UP_LIMITS_MINOR.max` (one top-up cannot
 *    cover it), the same threshold the booking copy switches on.
 *
 * "Or more" is true at any figure: a top-up of `reserved − available` makes the check pass, and
 * more never hurts. It promises nothing else — a colleague's booking can move the figure.
 */
export interface CardRemovalUncoveredCopyContext {
  /** `1 upcoming consultation` / `3 upcoming consultations`. */
  readonly count: string;
  /** `Northwind's` / `your team's`. */
  readonly company: string;
  /** `A$1,234.50`. */
  readonly amount: string;
}

export const CARD_REMOVAL_UNCOVERED_COPY = {
  figure: (c: CardRemovalUncoveredCopyContext): string =>
    `This card is backing ${c.count} — more than ${c.company} balance covers right now. A top-up of ${c.amount} or more, or cancelling bookings, lets you remove it.`,
  large: (c: CardRemovalUncoveredCopyContext): string =>
    `This card is backing ${c.count} — more than ${c.company} balance covers right now. Top-ups totalling ${c.amount} or more, or cancelling bookings, let you remove it.`,
} as const;

/** The facts the api refusal carries, plus the company name the server action read. */
export interface CardRemovalUncoveredFacts {
  readonly topUpNeededMinor: number;
  readonly reservedBookingCount: number;
  /** `null` ⇒ no usable name — "your team's". */
  readonly companyName: string | null;
}

/** The company as the possessive the sentence names: "Northwind's", else "your team's". */
function companyPossessive(companyName: string | null): string {
  const name = companyName?.trim() ?? '';
  return name.length > 0 ? `${name}'s` : "your team's";
}

/**
 * The dialog's blocking message for a D10.6 refusal. Picks the `large` arm above the single
 * top-up maximum, exactly as the booking balance panel does.
 */
export function cardRemovalUncoveredMessage(facts: CardRemovalUncoveredFacts): string {
  const context: CardRemovalUncoveredCopyContext = {
    count: upcomingConsultationsLabel(facts.reservedBookingCount),
    company: companyPossessive(facts.companyName),
    amount: formatAud(facts.topUpNeededMinor),
  };
  const exceedsSingleTopUp = facts.topUpNeededMinor > TOP_UP_LIMITS_MINOR.max;
  return exceedsSingleTopUp
    ? CARD_REMOVAL_UNCOVERED_COPY.large(context)
    : CARD_REMOVAL_UNCOVERED_COPY.figure(context);
}
