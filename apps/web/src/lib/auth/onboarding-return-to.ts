/**
 * BAL-502 FIX round — HIGH 3.
 *
 * A brand-new account created from the anonymous `/expert/apply` wizard (BAL-502
 * §22) never returned there: `signup-step.tsx` / `verify-step.tsx` push straight
 * to `/onboarding` (needed — a new account is never onboarded), and onboarding's
 * terminal redirect hardcodes `/dashboard` (client intent) or was otherwise
 * unaware `/expert/apply` was ever the origin. The filled application sat in
 * sessionStorage until the tab closed, with no way back to it.
 *
 * `buildOnboardingUrl` is the ONE place that decides whether the post-signup
 * `/onboarding` push should carry a pending-apply intent. Deliberately narrow:
 * it recognises `/expert/apply` ONLY, not an arbitrary `returnTo` — a generic
 * "return wherever you came from" would change onboarding's terminal redirect
 * for every entry point (marketing header, `/experts`, etc.), which is explicit
 * out-of-scope risk for a header-ticket FIX round. This mirrors the existing
 * `auth_return_to` OAuth cookie pattern (`initiateGoogleOAuth`,
 * `api/auth/callback/route.ts`) but is a plain query param, since the
 * email/password path never leaves the tab (no cookie round-trip needed).
 */
const PENDING_APPLY_PATH = '/expert/apply';

/**
 * `pathname` is the CURRENT page's path at the moment the auth modal succeeds —
 * the modal is an in-place overlay, so this is still `/expert/apply` when the
 * visitor signed up from there, exactly like `SocialAuthButtons` already computes
 * `globalThis.location.pathname` for the OAuth `returnTo` cookie.
 */
export function buildOnboardingUrl(pathname: string): string {
  if (pathname === PENDING_APPLY_PATH) {
    return `/onboarding?returnTo=${encodeURIComponent(PENDING_APPLY_PATH)}`;
  }
  return '/onboarding';
}

/**
 * The mirror image, read on the onboarding side. Exact-match ONLY (never forwards
 * an arbitrary user-controlled string into a `router.push`) — this is a boolean
 * gate, not an open redirect surface: the caller substitutes its OWN hardcoded
 * `/expert/apply` literal, never this function's input, when the check passes.
 */
export function hasPendingApplyIntent(returnToParam: string | null | undefined): boolean {
  return returnToParam === PENDING_APPLY_PATH;
}

export { PENDING_APPLY_PATH };
