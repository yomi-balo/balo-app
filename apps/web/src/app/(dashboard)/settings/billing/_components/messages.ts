/**
 * BAL-526 (D2) — the one `UNCONFIGURED_MESSAGE` literal shared, byte-identical, by
 * `payment-method-manager.tsx` and `card-capture-panel.tsx`. Both surfaces show this when
 * `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is unset.
 *
 * Pure string constant, no imports — safe for both `'use client'` modules to import directly.
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
