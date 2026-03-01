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
 * SYNC: This function is duplicated in validation.ts (Server) and route-config.ts (Edge).
 * Changes must be applied to both files.
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
