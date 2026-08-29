import 'server-only';

const DEFAULT_REDIRECT = '/dashboard';

/**
 * Validate and normalize a returnTo path to prevent open redirects.
 * Uses URL parsing to ensure the path stays on the same origin.
 *
 * BAL-494 — extracted from `api/auth/session-sync/route.ts` so
 * `api/auth/switch-workspace/route.ts` shares the SAME open-redirect guard rather than a
 * copy-pasted second one (Sonar new-code duplication gate). It blocks other origins,
 * protocol-relative URLs, dot-segment smuggling (see the guard below — a bug the extracted
 * original carried, fixed here for BOTH routes), and `/login` / `/signup` / `/api/auth`
 * (which also prevents a switch → switch redirect loop).
 */
export function getSafeRedirectPath(returnTo: string | null, baseUrl: string): string {
  if (!returnTo) return DEFAULT_REDIRECT;

  try {
    // Parse relative to the request origin — if returnTo contains a different
    // host, new URL() will resolve it and we detect it below.
    const parsed = new URL(returnTo, baseUrl);
    const base = new URL(baseUrl);

    // Must stay on the same origin (blocks absolute URLs, protocol-relative, etc.)
    if (parsed.origin !== base.origin) return DEFAULT_REDIRECT;

    const path = parsed.pathname;

    // ⚠ SECURITY — the origin check above is NOT sufficient on its own. WHATWG URL parsing
    // performs dot-segment removal, so `/.//evil.com`, `/..//evil.com` and `/x/..//evil.com`
    // all resolve to a SAME-ORIGIN url whose `pathname` is the protocol-relative string
    // `//evil.com`. Handing that back to a caller that does
    // `NextResponse.redirect(new URL(path, request.url))` re-parses it as `//evil.com` → the
    // ATTACKER's origin. Re-assert on the EXTRACTED pathname the same invariant
    // `route-config.ts`'s `isValidReturnTo` asserts on raw input.
    if (!path.startsWith('/') || path.startsWith('//')) return DEFAULT_REDIRECT;

    // Block auth paths to prevent redirect loops
    if (path.startsWith('/login') || path.startsWith('/signup') || path.startsWith('/api/auth')) {
      return DEFAULT_REDIRECT;
    }

    return path;
  } catch {
    return DEFAULT_REDIRECT;
  }
}
