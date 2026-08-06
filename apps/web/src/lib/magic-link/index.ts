import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * magic-link — the three helpers every PUBLIC, token-bearing surface needs: hash a
 * presented bearer token, compare two hashes in constant time, and resolve a
 * best-effort client IP for the defense-in-depth limiter.
 *
 * `server-only`: this imports `node:crypto` and must never reach a client bundle.
 *
 * ⚠ EXTRACTED, NOT COPIED. BAL-390 alone needs all three in TWO files — the
 * `/review/{token}` landing RSC and the `submitTokenReviewAction` Server Action — so a
 * private copy per file would put an identical ~20-line block in several places and
 * trip SonarCloud's >3% new-code duplication gate. The shape is verbatim the one
 * `/shared/proposals/{token}` shipped in BAL-386; only its home changed.
 */

/** SHA-256 of `value`, hex-encoded. The RAW token is never persisted or logged. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Constant-time equality of two hex strings — belt-and-braces over the DB lookup, so a
 * timing difference on the compare cannot narrow a token guess. Length-guarded because
 * `timingSafeEqual` throws on unequal-length buffers.
 */
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Best-effort client IP for the per-instance rate limiter. Spoofable, and deliberately
 * treated as such: the PRIMARY control on these surfaces is the ≥256-bit unguessable
 * token, and the limiter is only there to blunt a scanner storm.
 */
export function clientIp(headerList: Headers): string {
  const forwarded = headerList.get('x-forwarded-for');
  if (forwarded !== null) {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) {
      return first;
    }
  }
  return headerList.get('x-real-ip') ?? 'unknown';
}
