import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * BAL-408 (D2) — the ONE place `apps/api` mints a guest JOIN token.
 *
 * Modelled on `lib/review-token.ts`, with one deliberate difference: that helper WRITES the
 * row itself, this one does not. A guest invite is a BATCH inside one transaction
 * (`meetingGuestsRepository.createMany`), so the mint must be separable from the write —
 * the service mints N tokens, then commits N rows atomically.
 *
 * ⚠ THE RAW TOKEN IS RETURNED ONCE AND IS NEVER RECOVERABLE. It is never persisted, never
 * logged, never put in an audit row and never in an analytics property. It appears ONLY
 * inside the emailed URL and in the in-memory publish payload — the deliberate
 * secret-in-queue exception, exactly the `ProposalSharedPayload.shareToken` /
 * `ReviewReminderPayload.reviewToken` precedent. A caller that loses it must mint a new one.
 *
 * ⚠ HASHING DELIBERATELY LIVES HERE, NOT IN `@balo/db`. The repository takes the HASH, so
 * the raw secret never reaches the data layer and cannot be captured by the Drizzle
 * query-logging hook in `packages/db/src/client.ts` (which sees every bind parameter).
 * `meetingGuestsRepository.createMany`'s contract is written around that. Do not move it.
 *
 * ⚠ AND IT IS DELIBERATELY **NOT** UNIFIED WITH `apps/web`'s `lib/magic-link`'s `sha256Hex`
 * THROUGH A `@balo/shared` SERVER-ONLY SUBPATH. `apps/api`'s tsup bundles at `platform=node`
 * WITHOUT the `react-server` condition, so `import 'server-only'` resolves to the THROWING
 * entry: it typechecks, builds green, and crash-loops Railway (recorded on PR #191). It is
 * also unnecessary — `apps/api` needs only the hash (one expression, below) and `apps/web`
 * needs only the verify trio, so there is no duplicated block to extract.
 *
 * ⚠ 43 CHARS, 256 BITS, base64url — the exact shape `proposal_share_links` (BAL-386) and
 * `review_invite_tokens` (BAL-390) use. The algorithm is PINNED BY A TEST rather than
 * asserted only as "not the raw value": a `not.toBe(raw)` assertion stays green if the mint
 * silently switches to sha512, and every emailed join link would then render
 * `<LinkNotActive />` in production with CI fully green.
 */
export interface MintedGuestToken {
  /** ⚠ NEVER persist, log or trace this. Emailed URL only. */
  rawToken: string;
  /** SHA-256 hex (64 chars) — the ONLY half that crosses into `@balo/db`. */
  tokenHash: string;
}

export function mintGuestInviteToken(): MintedGuestToken {
  const rawToken = randomBytes(32).toString('base64url');
  // ⚠ THROUGH `hashGuestToken`, NOT AN INLINE `createHash`. The mint and the VERIFY
  // (`joinMeetingAsGuest`) must agree on the algorithm forever; two inline expressions can
  // drift, and the failure mode is silent — every emailed link would resolve to "not active"
  // in production with typecheck, lint and vitest all green.
  return { rawToken, tokenHash: hashGuestToken(rawToken) };
}

/**
 * SHA-256 hex of a raw guest token — the ONE hashing definition `apps/api` has.
 *
 * ⚠ BAL-132 EXTRACTED THIS FROM `mintGuestInviteToken`'S BODY rather than adding a second
 * `createHash` call, because this ticket introduces the first VERIFY path in `apps/api`: the
 * guest presents a raw token to `POST /meetings/:meetingId/guest-join`, and the service must
 * derive the same hash the mint stored. Two definitions of "the hash" is the defect
 * `apps/web`'s `sha256Hex` / `hashesMatch` pair already avoids on its own side.
 *
 * ⚠ THE RAW TOKEN NEVER REACHES `@balo/db`. Hashing stays here, in the app layer, so the
 * secret cannot be captured by the Drizzle query-logging hook in `packages/db/src/client.ts`,
 * which sees every bind parameter. The repository takes only the hash.
 */
export function hashGuestToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Constant-time equality for two token HASHES. Mirrors `apps/web`'s `hashesMatch`.
 *
 * ⚠ BELT-AND-BRACES, AND HONESTLY SO. The lookup is already `WHERE token_hash = $1` on an
 * indexed column, so a mismatch normally yields no row at all and this never fires. It exists
 * for the same reason the `/join/{token}` page re-compares after its lookup: a defensive
 * re-check costs nothing, and a byte-comparison on a secret-derived value is the one place a
 * `===` would be a (very theoretical) timing oracle. Not a substitute for the query.
 *
 * ⚠ THE LENGTH CHECK IS NOT OPTIONAL — `timingSafeEqual` THROWS on unequal-length buffers,
 * so calling it bare would turn a malformed input into a 500.
 */
export function guestTokenHashesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}
