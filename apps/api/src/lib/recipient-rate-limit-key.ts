import { createHash } from 'node:crypto';

/**
 * BAL-442 — the recipient-keyed lobby re-entry rate limit's identifier half.
 *
 * ⚠⚠ HASHED, SO NO RAW ADDRESS EVER ENTERS REDIS. The three caller-keyed windows on
 * `POST /meetings/:meetingId/lobby/reentry` bound a *caller*; this is the FOURTH window and
 * the only one that bounds an *inbox* — see `LOBBY_REENTRY_RECIPIENT_RATE_LIMIT`'s own
 * docblock in `routes/meetings/join.ts`. Redis key material is exactly the kind of place an
 * email address should never sit in plaintext: it is long-lived, it is scanned by anyone with
 * Redis access, and it has no TTL shorter than the rate-limit window itself.
 *
 * ⚠ SHA-256, TRUNCATED TO THE FIRST 32 HEX CHARACTERS (128 bits) — plenty of collision
 * resistance for a rate-limit BUCKET (not a security boundary on its own; the boundary is the
 * database `WHERE` clause on the actual mutation), and short enough to keep the composite Redis
 * key (`${meetingId}|${hash}`) compact. Truncating a cryptographic hash for a NON-secret bucket
 * key is the same trade `correlationId` makes with `tokenHash.slice(0, 16)`.
 *
 * ⚠ THE CALLER MUST PASS THE ALREADY-CANONICALISED ADDRESS (`canonicalGuestEmail`). This
 * function does not canonicalise — the route canonicalises ONCE and threads the same string
 * into both the rate-limit key and the repository lookup, so the two can never disagree on
 * which mailbox is being bounded. See `routes/meetings/join.ts`'s reentry handler.
 */
export function hashRateLimitRecipient(canonicalEmail: string): string {
  return createHash('sha256').update(canonicalEmail).digest('hex').slice(0, 32);
}
