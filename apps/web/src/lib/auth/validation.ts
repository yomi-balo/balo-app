import 'server-only';

/**
 * Validate the return-to path to prevent open redirect attacks.
 * Only allow relative paths starting with /.
 * Reject absolute URLs, protocol-relative URLs, and paths with special characters.
 * SYNC: This function is duplicated in route-config.ts (Edge) and validation.ts (Server).
 * Changes must be applied to both files.
 */
export function isValidReturnTo(path: string): boolean {
  // Must start with /
  if (!path.startsWith('/')) return false;
  // Must not start with // (protocol-relative URL)
  if (path.startsWith('//')) return false;
  // Must not contain protocol
  if (path.includes('://')) return false;
  // Must not contain backslash (path traversal on Windows)
  if (path.includes('\\')) return false;
  // Must not redirect to auth-related paths (avoid loops)
  if (path.startsWith('/api/auth') || path.startsWith('/login') || path.startsWith('/signup')) {
    return false;
  }
  return true;
}
