'use client';

import { useReducedMotion } from 'motion/react';

/**
 * BAL-493 §11 — the ONE reduced-motion read for the whole marketing-home motion primitive
 * family (`RevealGroup`, `Parallax`, `useCountUp`, `useTypewriter`).
 *
 * `motion/react`'s `useReducedMotion()` returns `boolean | null` — `null` until the media
 * query is evaluated on the client (and always on the server, where there is no media query to
 * read). This wrapper normalizes that to a definite `boolean` via `=== true`, matching the
 * idiom already used at 33 other call sites in this repo (e.g.
 * `apps/web/src/app/(dashboard)/expert/settings/_components/calendar-sync-pending-notice.tsx`).
 * "Unknown" therefore defaults to "motion is fine" — the same default the rest of the app uses.
 *
 * ⚠ This does NOT port the design reference's `usePrefersReduced` (`marketing-home.jsx:1169`),
 * a hand-rolled `matchMedia` hook. `motion` v12 is already a dependency and the repo's
 * established idiom is `useReducedMotion` from `motion/react` — no reason to duplicate it.
 */
export function useMarketingReducedMotion(): boolean {
  return useReducedMotion() === true;
}
