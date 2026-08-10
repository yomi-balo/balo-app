import { createHash, randomBytes } from 'node:crypto';

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
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}
