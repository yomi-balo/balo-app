import { createHash, randomBytes } from 'node:crypto';
import { reviewInviteTokensRepository } from '@balo/db';

/**
 * BAL-390 (D8) — the ONE place `apps/api` generates a review magic-link token.
 *
 * Two producers need it (the hourly review-nudge sweep and `auto-accept-sweep`'s
 * `autoAcceptOne`), and it is a SECURITY primitive: 256 bits of entropy, SHA-256 hashed
 * before it ever touches the database. Duplicating those two lines would mean a future
 * entropy or hashing change lands in one producer and not the other, which is exactly
 * the kind of drift that is invisible in review.
 *
 * ⚠ THE RAW TOKEN IS RETURNED ONCE AND IS NEVER RECOVERABLE. It is never persisted,
 * never logged, and never put in an audit row or an analytics property — it appears
 * only inside the emailed URL and in the in-memory publish payload (the deliberate
 * secret-in-queue exception, exactly the `ProposalSharedPayload.shareToken` precedent).
 * A caller that loses it must mint a new one.
 *
 * ⚠ HASHING DELIBERATELY LIVES HERE, NOT IN THE REPOSITORY. `@balo/db` takes the HASH, so
 * the raw secret never reaches the data layer and cannot be logged by the Drizzle query
 * hook; `reviewInviteTokensRepository.create`'s contract is written around that. The web
 * producer (`accept-project.ts`) hashes at its own call site via `sha256Hex` from
 * `@/lib/magic-link` — the same helper its verifier uses — mirroring the
 * `proposal_share_links` web action.
 *
 * (An earlier version of this note justified the split with "no production file under
 * `packages/db/src` imports `node:crypto`". That was FALSE — `scheduled-notifications.ts`
 * imports `randomUUID` and is barrel-exported. The keep-the-secret-out-of-the-data-layer
 * reasoning above stands on its own; the head-count did not.)
 *
 * ⚠ DOES NOT REVOKE PRIOR TOKENS. Up to three live tokens per (engagement, reviewer)
 * legitimately coexist — the star links in an email the client may not have opened yet
 * must keep working. They grant no extra power: every one of them resolves to the same
 * (engagement, reviewer) pair and the same upsert key.
 *
 * THROWS on a database failure. Callers decide the posture — both current callers treat
 * a mint failure as "publish without a review block", never as a failed accept.
 */
export async function mintReviewInviteToken(input: {
  engagementId: string;
  reviewerUserId: string;
}): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  await reviewInviteTokensRepository.create({
    engagementId: input.engagementId,
    reviewerUserId: input.reviewerUserId,
    tokenHash,
  });

  return rawToken;
}
