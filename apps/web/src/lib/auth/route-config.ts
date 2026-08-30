/**
 * Route classification for middleware.
 * NO 'server-only' import — must be Edge Runtime compatible.
 */

/** Exact public paths (no auth required) */
export const PUBLIC_PATHS = new Set([
  '/',
  '/login',
  '/signup',
  '/reset-password',
  '/experts',
  '/about',
  '/pricing',
  '/contact',
  '/admin-dev',
  // BAL-502 — the marketing header's supply-side "For experts" link target. EXACT PATH ONLY:
  // `PUBLIC_PATHS` is matched with `.has(pathname)` (see `isPublicRoute` below), so
  // `/expert/apply/success` and `/expert/apply/review` stay protected.
  //
  // ⚠ This one is GENUINELY reachable signed-out — it does not merely defer to a page-level
  // redirect. `(apply)/expert/apply/page.tsx` renders an anonymous preview for a null user
  // (BAL-502 §22): public taxonomy only, via `loadReferenceData()`. No draft is read, no user
  // is dereferenced, and there is NO anonymous write path — an anonymous draft lives in
  // `sessionStorage` and is replayed through the auth-owning flush endpoint only after
  // sign-in. The auth wall sits at SUBMIT (`step-terms.tsx`), not at view.
  //
  // `loadDraftAction` remains `withAuth`-wrapped, so the authenticated branch is unchanged.
  '/expert/apply',
  // BAL-510 — TEMPORARY. The `/v2` marketing-home direction preview. Unlinked and
  // `noindex`, but it must be reachable SIGNED OUT: it is a marketing home, so the whole
  // point is seeing it with the anonymous `MarketingHeader` variant, the same way `/` and
  // `/experts` are seen. Without this line middleware 307s anonymous visitors to
  // `/login?returnTo=%2Fv2` and the V1-vs-V2 comparison cannot be done in a fresh browser.
  // Safe to expose: the page renders only hard-coded sample data plus the same PUBLIC
  // product taxonomy `/experts` already serves anonymously — no user is dereferenced and
  // there is no write path of any kind.
  // ⚠ PAIRED TEARDOWN: delete this line together with `app/(marketing)/v2/` (see BAL-493).
  '/v2',
]);

/** Prefix-based public paths */
export const PUBLIC_PREFIXES: readonly string[] = [
  '/api/auth/',
  '/api/webhooks/',
  '/api/health',
  '/experts/',
  '/blog/',
  // BAL-386 — public, no-auth, email-bound magic-link proposal view.
  '/shared/proposals/',
  // BAL-390 — public, no-auth, token-authenticated star-rating landing
  // (`/review/{token}`). The token NAMES the reviewer; it is not authorization — the
  // submit Server Action still evaluates PARTICIPATE on the engagement's company.
  // ⚠ PAIRED EDIT: `/review/` must ALSO be in SENSITIVE_PATH_PREFIXES
  // (@balo/shared/redaction). This entry without that one puts every raw token into
  // Axiom (Edge request logging) and PostHog ($current_url / $pathname / $referrer);
  // that one without this 302s every emailed reviewer to /login. One without the
  // other IS the defect — route-config.test.ts asserts the pairing.
  '/review/',
  // BAL-408 / ADR-1044 — public, no-auth, token-authenticated guest join landing
  // (`/join/{token}`). The token is an IDENTITY CLAIM ("who the visitor says they
  // are"), never an authorization grant: every read re-checks the guest row's live
  // state and the meeting's own state, so revocation is immediate and total.
  // ⚠ SAME PAIRED EDIT: `/join/` must ALSO be in SENSITIVE_PATH_PREFIXES
  // (@balo/shared/redaction). A guest token is deliberately NOT single-use, so a
  // single logged copy stays replayable for the whole 7-day window.
  '/join/',
  // ⚠ BAL-132 — `/join/m/{meetingId}`, the anonymous lobby. **REDUNDANT FOR ROUTING** (the
  // `/join/` entry above already matches it by `startsWith`) and present anyway, because the
  // paired-registry invariant below asserts EXACT containment: every entry in
  // `SENSITIVE_PATH_PREFIXES` must appear here verbatim. `/join/m/` had to be added there —
  // `redactSensitivePath` returns on its first matching prefix, so `/join/` alone redacts the
  // literal segment `m` and leaves the meeting id in the URL — and this line is what keeps
  // the two registries provably paired rather than "covered by a prefix that happens to
  // overlap". Do not delete it as dead weight; `route-config.test.ts` fails if you do.
  '/join/m/',
];

/** Admin path prefix (requires platformRole admin or super_admin) */
const ADMIN_PREFIX = '/admin';

export const ONBOARDING_PATH = '/onboarding';

/**
 * The onboarding wizard root OR any nested onboarding route (e.g. BAL-348's
 * `/onboarding/join-result` deep-link landing). Used to EXEMPT the not-onboarded
 * redirect: a request-mode requester who never finished onboarding must be able to
 * reach the join-result terminal screen rather than being bounced to the wizard root.
 * The completed-user bounce stays keyed on the exact wizard root (`=== ONBOARDING_PATH`),
 * so a completed user still sees the terminal screen and only the bare wizard bounces.
 */
export function isOnboardingRoute(pathname: string): boolean {
  return pathname === ONBOARDING_PATH || pathname.startsWith(ONBOARDING_PATH + '/');
}

export function isPublicRoute(pathname: string): boolean {
  return (
    PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export function isAdminRoute(pathname: string): boolean {
  return pathname === ADMIN_PREFIX || pathname.startsWith(ADMIN_PREFIX + '/');
}

export function isApiRoute(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

/**
 * Validate returnTo path to prevent open redirect attacks.
 * Single source of truth — validation.ts re-exports this for server-side code.
 */
export function isValidReturnTo(path: string): boolean {
  if (!path.startsWith('/')) return false;
  if (path.startsWith('//')) return false;
  if (path.includes('://')) return false;
  if (path.includes('\\')) return false;
  if (path.startsWith('/api/auth') || path.startsWith('/login') || path.startsWith('/signup')) {
    return false;
  }
  return true;
}
