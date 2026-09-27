/**
 * BAL-474 (plan AD-16) — THE ONE DEFINITION of what a single top-up may be, in AUD minor units:
 * at least A$300, at most A$10,000, in A$100 steps. The web top-up slider
 * (`apps/web/src/lib/credit/display-constants.ts`), the internal purchase-intent route's
 * defence-in-depth bounds (`apps/api/src/routes/credit/purchase-intent.ts`) and the dunning /
 * booking copy that says "a top-up of {amount} or more" (and switches to "top-ups totalling" above
 * the single-top-up maximum) all read these three numbers, so a limit can never be changed in one
 * place and quoted stale in another.
 */
export const TOP_UP_LIMITS_MINOR = {
  /** A$300 — the smallest single top-up the page accepts. */
  min: 30_000,
  /** A$10,000 — the largest single top-up; a figure above it needs several. */
  max: 1_000_000,
  /** A$100 — the slider's snap. */
  step: 10_000,
} as const;
