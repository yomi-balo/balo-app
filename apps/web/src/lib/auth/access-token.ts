/**
 * Pure WorkOS access-token (JWT) expiry helpers. Dependency-free on purpose:
 * `middleware-session.ts` runs in the Edge Runtime and cannot import `server-only` modules,
 * while the booking Server Action runs in Node.
 *
 * ⚠ A local read, not verification — the signature is never checked, so this answers
 * "definitely expired" but never "definitely valid". Use it as a pre-flight gate in front of a
 * boundary that verifies properly, never as the boundary.
 */

/** The `exp` claim in epoch SECONDS, or `null` when the token is unreadable. */
export function getAccessTokenExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const encodedPayload = parts[1];
    if (!encodedPayload) return null;
    // JWT uses base64url encoding; atob() expects standard base64
    const base64 = encodedPayload.replaceAll('-', '+').replaceAll('_', '/');
    const payload = JSON.parse(atob(base64)) as { exp?: unknown };
    // A non-numeric `exp` is an unreadable token, not a token that never expires — `?? null`
    // alone would hand a string or an object straight into the arithmetic below.
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Is the token expired, or within `bufferSeconds` of expiring? An unreadable token counts as
 * expired. `bufferSeconds` is the caller's risk posture: the middleware refreshes proactively on
 * a wide buffer, a pre-flight gate wants a narrow one.
 */
export function isAccessTokenExpired(token: string, bufferSeconds = 0): boolean {
  const exp = getAccessTokenExpiry(token);
  if (exp === null) return true;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return exp - nowSeconds < bufferSeconds;
}
