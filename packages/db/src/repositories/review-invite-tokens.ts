import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import { reviewInviteTokens, type ReviewInviteToken } from '../schema';
import { auditEventsRepository } from './audit-events';

const ENTITY_TYPE = 'review_invite_token';

export interface CreateReviewInviteTokenInput {
  engagementId: string;
  /** The token's SUBJECT — an identity claim, never an authorization grant (see the schema). */
  reviewerUserId: string;
  /** SHA-256 hex of the raw token; the RAW token is never passed here or persisted. */
  tokenHash: string;
  /** Optional explicit expiry; the DB default (`now() + 30 days`) applies when omitted. */
  expiresAt?: Date;
}

/**
 * `reviewInviteTokensRepository` (BAL-390 / D8) — the magic-link store behind
 * `/review/{token}`. Mirrors `proposalShareLinksRepository` method-for-method, minus the
 * reshare-revokes-prior step, which this table deliberately does NOT do (§ the
 * NON-UNIQUE `review_invite_token_engagement_reviewer_idx`: up to three live tokens per
 * (engagement, reviewer) coexist, because the raw token is unrecoverable from its hash
 * so each nudge must mint a fresh one, and revoking the prior would kill the star links
 * in an email the client may not have opened yet).
 *
 * ⚠ HASHING STAYS IN THE CALLER — SHA-256 hex, exactly as the proposal-share web action
 * does. The reason is that the RAW secret must never reach the data layer, where the
 * Drizzle query-logging hook could capture it; it is NOT that this package avoids
 * `node:crypto` (an earlier version of this note claimed that, and it was false —
 * `scheduled-notifications.ts` imports `randomUUID`). Do not move hashing in here.
 *
 * ⚠ NO `revoke` / `revokeAllFor` METHOD SHIPS. No caller exists and CLAUDE.md forbids
 * dead code. The `revoked_at` column and the live filter DO ship, so a future ops
 * revoke needs no migration. In the meantime revocation is free and durable anyway: the
 * submit action re-evaluates `hasCapability(reviewer, PARTICIPATE, { companyId })` on
 * EVERY submit, so a soft-deleted `company_members` row stops every one of that
 * person's outstanding tokens from writing, instantly.
 */
export const reviewInviteTokensRepository = {
  /**
   * Mint a token. ONE transaction: insert + audit `review_invite_token.created`, so the
   * audit row and the token commit or roll back together.
   *
   * `actorUserId` is NULL by design — ADR-1030's system-actor attribution exemption.
   * Minting is a MACHINE act on the notification path (the nudge sweep, or the email
   * producer on an acceptance); no person chooses to issue a token, and the person the
   * token names is its SUBJECT, not its actor. Recording the reviewer here would assert
   * they did something they did not do.
   */
  create: async (input: CreateReviewInviteTokenInput): Promise<ReviewInviteToken> => {
    return db.transaction(async (tx) => {
      const [token] = await tx
        .insert(reviewInviteTokens)
        .values({
          engagementId: input.engagementId,
          reviewerUserId: input.reviewerUserId,
          tokenHash: input.tokenHash,
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        })
        .returning();
      if (token === undefined) {
        throw new Error('review_invite_tokens insert returned no row');
      }

      await auditEventsRepository.record(
        {
          actorUserId: null,
          action: 'review_invite_token.created',
          entityType: ENTITY_TYPE,
          entityId: token.id,
          // ⚠ NEVER the raw token and never the hash — an audit row is a durable,
          // widely-readable record, and the hash is the only secret-adjacent value here.
          metadata: {
            engagementId: input.engagementId,
            reviewerUserId: input.reviewerUserId,
          },
        },
        tx
      );

      return token;
    });
  },

  /**
   * Resolve a token by its hash — but ONLY if it is currently usable: live (not
   * soft-deleted), not revoked, and not past its expiry. Rides the unique
   * `review_invite_token_hash_idx`.
   *
   * Returns `undefined` for a WRONG, EXPIRED, REVOKED or DELETED token WITHOUT
   * distinguishing them — by design, verbatim the `proposal_share_links` contract. The
   * landing page renders one identical "link is no longer active" card for all four, so
   * the response is not an oracle for whether a token ever existed.
   */
  findLiveByTokenHash: async (tokenHash: string): Promise<ReviewInviteToken | undefined> => {
    const [row] = await db
      .select()
      .from(reviewInviteTokens)
      .where(
        and(
          eq(reviewInviteTokens.tokenHash, tokenHash),
          isNull(reviewInviteTokens.deletedAt),
          isNull(reviewInviteTokens.revokedAt),
          gt(reviewInviteTokens.expiresAt, sql`now()`)
        )
      );
    return row;
  },

  /**
   * Stamp an access: bump `access_count`, set `last_accessed_at`.
   *
   * ⚠ The counter is SCANNER-INFLATED (Gmail's proxy, Safe Links detonation) — a coarse
   * liveness signal, never "human opens". See the column docblock.
   */
  recordAccess: async (id: string): Promise<void> => {
    await db
      .update(reviewInviteTokens)
      .set({
        lastAccessedAt: sql`now()`,
        accessCount: sql`${reviewInviteTokens.accessCount} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(reviewInviteTokens.id, id));
  },
};
