import {
  pgTable,
  uuid,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { engagements } from './engagements';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * review_invite_tokens (BAL-390 / D8) — the bearer token behind the `/review/{token}`
 * magic-link landing, so a client can rate an engagement straight from an email without
 * signing in first. Modelled method-for-method on `proposal_share_links`.
 *
 * ⚠⚠ THE TOKEN NAMES THE REVIEWER; IT IS NOT AUTHORIZATION. Resolving a token tells the
 * submit action WHO the writer claims to be — nothing more. The action still runs
 * `hasCapability(reviewer, CAPABILITIES.PARTICIPATE, { companyId })` on EVERY submit
 * (D8/D10). That submit-time evaluation is also a free, durable REVOCATION CHANNEL: when
 * a reviewer's `company_members` row is soft-deleted, `getMemberRole` returns undefined
 * and every one of their outstanding 30-day tokens stops writing instantly, with no
 * revocation step to run and no rows to find.
 *
 * SECURITY: only `token_hash` (SHA-256 hex, 64 chars, of a >=256-bit random token) is
 * ever persisted. The RAW token is returned to the caller ONCE at mint and is NEVER
 * stored, logged, or recoverable — the hashing itself stays in the CALLER, exactly as
 * `proposal_share_links` does (no production file under `packages/db/src` imports
 * `node:crypto`; only the test factory does).
 *
 * NO `expert_profile_id` COLUMN — deliberate. The submit path derives the expert from
 * the engagement at write time, so a token can never pin an expert other than the one who
 * actually delivered.
 *
 * NO RLS — see the `reviews` / `proposal_share_links` rationale.
 */
export const reviewInviteTokens = pgTable(
  'review_invite_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),

    /**
     * WHO the token says is reviewing — AN IDENTITY CLAIM, NOT AN AUTHORIZATION GRANT
     * (see the ⚠⚠ above).
     *
     * CASCADE, not `restrict`: a token is meaningless without its subject and is NOT an
     * attribution record — `reviews.reviewer_user_id` is, and that one is `restrict`.
     */
    reviewerUserId: uuid('reviewer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** SHA-256 hex (64 chars). The raw token is NEVER persisted. */
    tokenHash: text('token_hash').notNull(),

    /**
     * D8 — 30 days, as a DB-LEVEL interval default so the window is right even if a
     * caller omits it (the `proposal_share_links` contract). It must comfortably outlive
     * the +7d nudge; 30d leaves 23d of slack.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '30 days'`),

    /**
     * Filtered by `findLiveByTokenHash`. NO WRITER SHIPS IN BAL-390 — the column exists
     * so a future ops/moderation revoke needs zero migration. Submitting a review does
     * NOT revoke the token: D8 is reusable-until-expiry precisely so "change my review"
     * keeps working from the same link.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),

    /**
     * ⚠ SCANNER-INFLATED. Gmail's image proxy and Microsoft Safe Links detonation each
     * stamp an access. This is a coarse LIVENESS signal, never "human opens" — which is
     * also why no PostHog event fires on GET.
     */
    accessCount: integer('access_count').notNull().default(0),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // UNIQUE and INTENTIONALLY NON-PARTIAL — verbatim the `proposal_share_links` ruling:
    // tokens are random per issue and never re-created, so there is no
    // soft-delete-recreate collision to dodge, and the lookup MUST resolve across
    // live/revoked/expired/deleted states. DO NOT make this partial.
    uniqueIndex('review_invite_token_hash_idx').on(t.tokenHash),

    // ⚠ NON-UNIQUE, AND THAT IS THE DESIGN. UP TO THREE LIVE TOKENS PER
    // (engagement, reviewer) COEXIST. The forcing argument, because someone WILL try to
    // "fix" this into a partial unique:
    //   · the raw token is unrecoverable from the hash, so the +24h nudge CANNOT reuse
    //     the fused email's token — it must mint a fresh one;
    //   · with a one-live-token unique, minting T2 would have to revoke T1 (the
    //     `proposal_share_links` reshare pattern), silently killing the star links in an
    //     email the client may not have opened yet.
    // Multiple live tokens grant NO extra power: they resolve to the same
    // (engagement, reviewer) and therefore the same upsert key — the same capability.
    // Bonus: this table thereby dodges the soft-delete/partial-unique trap entirely.
    index('review_invite_token_engagement_reviewer_idx').on(t.engagementId, t.reviewerUserId),

    // The cascade FK's delete-time scan (admin-dev hard-deletes users — see the matching
    // note on `reviews.reviewer_user_id`).
    index('review_invite_token_reviewer_idx').on(t.reviewerUserId),

    check('review_invite_token_access_count_nonneg', sql`${t.accessCount} >= 0`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const reviewInviteTokensRelations = relations(reviewInviteTokens, ({ one }) => ({
  engagement: one(engagements, {
    fields: [reviewInviteTokens.engagementId],
    references: [engagements.id],
  }),
  reviewer: one(users, {
    fields: [reviewInviteTokens.reviewerUserId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type ReviewInviteToken = typeof reviewInviteTokens.$inferSelect;
export type NewReviewInviteToken = typeof reviewInviteTokens.$inferInsert;
