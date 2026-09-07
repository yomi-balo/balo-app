'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { initAnalytics, analytics, setAnalyticsErrorReporter } from '@/lib/analytics';

/**
 * ⚠⚠ FIX ROUND 1 F3 (security S3) — MODULE SCOPE, DELIBERATELY NOT a `useEffect`.
 *
 * React flushes passive effects DEPTH-FIRST / CHILD-FIRST: a descendant's `useEffect` commits
 * BEFORE its ancestors' — always, regardless of source order. `useSetupIntentRedirectReturn`
 * mounts several components below this provider (`/settings/billing`, `/redeem`) and calls
 * `track()` in its OWN mount effect for an unbound return (BAL-529 §D). When this init ran
 * inside `PostHogProvider`'s `useEffect`, that child effect committed FIRST — so `track()` →
 * `posthog.capture()` ran before `posthog.init()` ever had. posthog-js has NO pre-init queue for
 * `capture()` (verified against the shipped posthog-js@1.335.3 bundle: an uninitialized
 * `capture()` hits `uninitializedWarning` and returns) — so `stripe_redirect_return_unbound`
 * likely NEVER FIRED in production, and §D's whole business question got a permanent false zero.
 *
 * `useLayoutEffect` would NOT have fixed this — layout effects ALSO flush child-first, just
 * synchronously instead of after paint. The only fix that is unconditionally ahead of every
 * descendant's effect, regardless of tree depth or how many components sit between this
 * provider and the mount site, is to run before React starts committing the tree at all —
 * i.e. at MODULE EVALUATION time, which happens once, when this client bundle is first
 * imported, strictly before hydration/first-render effects fire. This mirrors
 * `apps/web/instrumentation-client.ts`'s Sentry init, which relies on the identical guarantee.
 * `initAnalytics()` is itself idempotent (the `initialized` module flag in
 * `packages/analytics/src/client/client.ts`), so re-evaluation (Fast Refresh, a second import in
 * a test) is safe. The reporter is installed FIRST, same as before.
 *
 * ⚠ FIX ROUND 3 R1 — the line this replaces used to claim "a failure during init is itself
 * reported", which was FALSE: at module scope, an unguarded `posthog.init` throw would fail
 * evaluation of THIS client bundle before the reporter (or anything else) could act on it — a
 * strictly worse blast radius than the `useEffect` this module-scope statement replaced.
 * `initAnalytics()` now wraps its own `posthog.init(...)` call in a try/catch
 * (`packages/analytics/src/client/client.ts`) that routes any failure to the installed reporter
 * with `method: 'init'`, the same shape `track`/`identify`/`page`/`reset` already used — so a
 * throw here can no longer escape this statement, and IS now genuinely reported once caught.
 *
 * Pinned WITHOUT mocking `initAnalytics` in
 * `posthog-provider.init-order.test.tsx` — the global test mock (`apps/web/src/test/setup.ts`)
 * stubs `track`/`initAnalytics` as bare `vi.fn()`s, which cannot prove anything about CALL
 * ORDER, which is why that proof lives in its own file that unmocks the barrel.
 *
 * ⚠ FIX ROUND 2 G6 — `globalThis.window` GUARD, for symmetry with `initAnalytics()` (which
 * already no-ops server-side via its own internal `globalThis.window === undefined` check in
 * `client.ts`). Without it, this module-scope statement — client-bundle-only in the browser,
 * but this FILE is also imported and evaluated during RSC render/prerender on the SERVER —
 * would install a Sentry reporter into `@balo/analytics/client`'s process-global module
 * singleton from the server process too. Harmless in practice today (`track()` returns early
 * server-side; nothing server-side currently calls `reportAnalyticsError`), but leaving it
 * unguarded is inconsistent with the sibling call right below and easy to make load-bearing by
 * accident later. `globalThis.window` (not bare `window`) per SonarCloud S7764, and a direct
 * `=== undefined` comparison (not `typeof … !== 'undefined'`) to match `client.ts`'s own guard
 * and satisfy `unicorn/no-typeof-undefined`.
 */
if (globalThis.window !== undefined) {
  setAnalyticsErrorReporter((error, { method }) => {
    Sentry.captureException(error, { tags: { analytics_method: method } });
  });
}
initAnalytics();

interface PostHogProviderProps {
  children: React.ReactNode;
  userId?: string;
  /** JSON-serialized traits string for stable useEffect dependency comparison. */
  userTraitsJson?: string;
}

export function PostHogProvider({
  children,
  userId,
  userTraitsJson,
}: Readonly<PostHogProviderProps>): React.JSX.Element {
  useEffect(() => {
    if (userId && userTraitsJson) {
      analytics.identify(userId, JSON.parse(userTraitsJson) as Record<string, unknown>);
    }
  }, [userId, userTraitsJson]);

  return <>{children}</>;
}
