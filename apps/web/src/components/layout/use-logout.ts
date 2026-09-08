'use client';

import { useCallback } from 'react';
import { track, AUTH_EVENTS, analytics } from '@/lib/analytics';
// ⚠ D10 — import the CONCRETE module, never the `@/lib/auth/actions` barrel. The barrel
// re-exports modules that value-import `@balo/db` → `postgres`, which explodes in jsdom.
// `logout.ts` imports only `../session` and `@/lib/logging`.
import { logoutAction } from '@/lib/auth/actions/logout';
import { forgetSetupIntent } from '@/lib/stripe/setup-intent-return';
// BAL-551 fix round F7 — a route-private helper, deliberately imported here anyway: this hook
// is the app's ONE client sign-out sequence (see the docblock below), and Recent's own header
// comment states clearing on sign-out is wired to this exact call site.
import { clearStoredRecentLookups } from '@/app/(dashboard)/admin/lookup/_lib/use-recent-lookups';

/**
 * BAL-501 (D10) — the three-step logout sequence, extracted verbatim from
 * `user-menu.tsx:100-106` so `mobile-more-sheet.tsx` can reuse it rather than re-implementing
 * the analytics deferral.
 *
 * BAL-529 §C (`OnboardingSignOut` consolidated onto this hook too) — the ONLY client sign-out
 * sequence in the app, so a future third entry point reuses it by construction.
 */
export function useLogout(): () => void {
  return useCallback(() => {
    track(AUTH_EVENTS.LOGOUT_COMPLETED, {});
    /**
     * BAL-529 §C — the tab-scoped SetupIntent binding (`@/lib/stripe/setup-intent-return`) is
     * bound to the TAB, not to the session. BAL-526's plan claimed it "dies with the tab", which
     * only holds if the tab dies with the session — it does not. On a shared machine: A starts a
     * capture, 3DS returns `processing` (params + binding deliberately kept), A signs out, the
     * tab stays open, B signs in and navigates Back to that history entry — the ids match, the
     * retrieve now says `succeeded`, and B's page paints "Card saved" for a card that is not
     * theirs. False paint only (no mandate state is written), and THIS EXPLICIT SIGN-OUT CALL
     * CLOSES IT — for this path.
     *
     * ⚠⚠ FIX ROUND 1 F5 (security S4) — CORRECTED: this call alone does NOT close the whole
     * shared-machine scenario, and an earlier version of this comment overclaimed that it did.
     * `clearMiddlewareSession` (`apps/web/src/middleware.ts`) tears the session down
     * SERVER-SIDE on decode failure or expiry and redirects to `/login` — NO CLIENT CODE RUNS
     * on that path, so this hook never fires and A's binding survives in the tab's
     * `sessionStorage` untouched. The residual is closed on the OTHER side of the handoff
     * instead: `password-step.tsx`'s sign-in success path also calls `forgetSetupIntent()`.
     *
     * ⚠⚠ FIX ROUND 2 G2 — CORRECTED AGAIN: "B's session starts clean regardless of how A's
     * ended … no third gap currently known" was ITSELF still false — there are at least
     * THREE MORE paths that establish B's session with NO client code running at all, none of
     * which calls `forgetSetupIntent()`, so B does NOT start clean when B signs in this way:
     *   1. OAUTH — `social-auth-buttons.tsx` (rendered on the same `email-step.tsx` step that
     *      leads to `password-step`, and on `signup-step.tsx`) → `initiateGoogleOAuth` /
     *      `initiateMicrosoftOAuth` → `apps/web/src/app/api/auth/callback/route.ts`'s
     *      `createSession(...)`. A server route + redirect response — this is exactly the gap
     *      this docblock was originally raised about.
     *   2. SIGN-UP — `apps/web/src/lib/auth/actions/sign-up.ts`'s `session.save()`;
     *      `signup-step.tsx` does not clear.
     *   3. EMAIL VERIFICATION — `apps/web/src/lib/auth/actions/verify-email.ts`'s
     *      `session.save()`.
     * `password-step.tsx`'s call and this one remain correct and load-bearing for the ONE path
     * they cover (email/password sign-in); they are just not a complete closure of the
     * shared-machine scenario. Closing the residual for real needs a shared post-auth CLIENT
     * seam that runs on every fresh authenticated page load regardless of how the session was
     * established — not built here; this is the honest state, not a fix.
     *
     * ⚠ SYNCHRONOUS, AHEAD OF `logoutAction()` — deliberately NOT deferred like the
     * `analytics.reset()` below, whose 500ms delay exists to let PostHog flush and which may
     * never run once the action navigates away.
     */
    forgetSetupIntent();
    // BAL-551 fix round F7 — synchronous, same reasoning as `forgetSetupIntent()` above: this
    // is a plain key removal, not an async flush, so it does not need the deferred timer.
    clearStoredRecentLookups();
    // Defer reset so PostHog flushes the event with the user's identity
    setTimeout(() => analytics.reset(), 500);
    logoutAction();
  }, []);
}
