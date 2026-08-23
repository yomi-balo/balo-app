import 'server-only';

import { sha256Hex } from '@/lib/magic-link';

/**
 * BAL-400 (Decision 1) — the booking idempotency key, derived SERVER-SIDE from the acting
 * user's id and a client-minted, per-submit-attempt nonce.
 *
 * ⚠⚠ HASHED WITH THE ACTOR ID, AND THAT IS LOAD-BEARING, NOT COSMETIC. A raw client-supplied
 * key would make `caseEngagementsRepository.findByBookingIdempotencyKey(key)` /
 * `meetingsRepository.findByBookingIdempotencyKey(key)` an IDOR: a stranger replaying someone
 * else's key would be handed their `engagementId`. Deriving the stored key from `userId` makes
 * cross-user collision structurally impossible, so both lookups are actor-scoped BY
 * CONSTRUCTION and need no second ownership query.
 *
 * `bookingNonce` is minted CLIENT-SIDE (`crypto.randomUUID()`, held in a `useRef`) and stays
 * STABLE across "Try again" retries of the SAME submit — it is regenerated only when a
 * booking-defining input changes (the slot, the case choice, the company). That is what makes
 * a retry re-enter against the case/meeting already created rather than mint a second one.
 *
 * REUSES `sha256Hex` from `@/lib/magic-link` (BAL-390) rather than a private `createHash` call
 * — the same "extracted, not copied" rationale that file's own docblock states: a private copy
 * here would be a second hashing helper carrying the identical five lines.
 */
export function deriveBookingIdempotencyKey(userId: string, bookingNonce: string): string {
  return sha256Hex(`${userId}:${bookingNonce}`);
}
