/**
 * BAL-526 (D2) — the one `UNCONFIGURED_MESSAGE` literal shared, byte-identical, by
 * `payment-method-manager.tsx` and `card-capture-panel.tsx`. Both surfaces show this when
 * `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is unset.
 *
 * Pure string constant, no imports — safe for both `'use client'` modules to import directly.
 */
export const STRIPE_UNCONFIGURED_MESSAGE =
  "Card payments aren't configured right now. Please try again later.";
