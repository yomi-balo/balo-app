import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

/**
 * BAL-361 / BAL-400 — the ONE secret gate every E2E-only route (`/api/auth/test-login`,
 * `/api/e2e/seed`) must open with, extracted here so a second seeding route can never be added
 * with a re-typed (and possibly drifted) copy of this check.
 *
 * SECURITY, deployment-agnostic, fail-safe, independent of `NODE_ENV` / `VERCEL` / platform:
 *   - `E2E_TEST_SECRET` absent (or empty) → 404, ALWAYS. Production never sets it, so every
 *     route calling this is inert in production regardless of the runtime environment. Empty
 *     string is treated as unset so a mis-provisioned secret fails CLOSED.
 *   - `E2E_TEST_SECRET` set, but the request's `x-e2e-secret` header is missing or wrong → 401
 *     (compared in constant time; see `secretMatches`).
 *   - `E2E_TEST_SECRET` set and the header matches → `null` (caller proceeds).
 *
 * `requireE2ESecret` MUST be the first statement in every handler that uses it, so a route can
 * never do any work — including a read — unless the caller presented the matching secret. The
 * secret is NEVER logged (both short-circuit branches return before any logging call).
 */

/**
 * Constant-time secret comparison that never throws on a length mismatch. `timingSafeEqual`
 * requires equal-length buffers, so both sides are reduced to fixed-length SHA-256 digests
 * before comparison. Absent/empty input → false.
 */
export function secretMatches(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

/**
 * Returns a `NextResponse` to short-circuit the handler with (404 when the harness is off, 401
 * on a missing/wrong secret), or `null` when the caller may proceed.
 */
export function requireE2ESecret(request: NextRequest): NextResponse | null {
  const expectedSecret = process.env.E2E_TEST_SECRET;

  // Prod path: E2E_TEST_SECRET is NEVER set in production → always 404, regardless of
  // NODE_ENV / VERCEL / platform. Empty string is treated as unset (fail closed).
  if (!expectedSecret) {
    return new NextResponse('Not Found', { status: 404 });
  }

  // Secret set but the request's header is missing or wrong → 401 (timing-safe).
  if (!secretMatches(request.headers.get('x-e2e-secret'), expectedSecret)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  return null;
}
