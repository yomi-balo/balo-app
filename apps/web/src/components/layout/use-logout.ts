'use client';

import { useCallback } from 'react';
import { track, AUTH_EVENTS, analytics } from '@/lib/analytics';
// ⚠ D10 — import the CONCRETE module, never the `@/lib/auth/actions` barrel. The barrel
// re-exports modules that value-import `@balo/db` → `postgres`, which explodes in jsdom.
// `logout.ts` imports only `../session` and `@/lib/logging`.
import { logoutAction } from '@/lib/auth/actions/logout';

/**
 * BAL-501 (D10) — the three-step logout sequence, extracted verbatim from
 * `user-menu.tsx:100-106` so `mobile-more-sheet.tsx` can reuse it rather than re-implementing
 * the analytics deferral.
 */
export function useLogout(): () => void {
  return useCallback(() => {
    track(AUTH_EVENTS.LOGOUT_COMPLETED, {});
    // Defer reset so PostHog flushes the event with the user's identity
    setTimeout(() => analytics.reset(), 500);
    logoutAction();
  }, []);
}
