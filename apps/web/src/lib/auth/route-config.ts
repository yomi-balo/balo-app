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
]);

/** Prefix-based public paths */
export const PUBLIC_PREFIXES: readonly string[] = [
  '/api/auth/',
  '/api/webhooks/',
  '/api/health',
  '/experts/',
  '/blog/',
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
