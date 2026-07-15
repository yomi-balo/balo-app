import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { requestExpertRelationships } from './request-origination';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * proposal_share_links (BAL-386) — an email-bound "magic link" a client-side sharer
 * mints to show a colleague the CURRENT proposal on a project without forcing that
 * colleague to have an account first. One LIVE link per (relationship, recipient).
 *
 * WHY key on `relationship_id`, NOT `proposal_id`: a proposal versions (resubmit
 * inserts a NEW `proposals` row — see `proposal_current_per_relationship_idx`). The
 * share follows the RELATIONSHIP; the current proposal is resolved at READ time from
 * the live relationship, so a reshare after a new version keeps working. Storing a
 * `proposal_id` here would silently pin the colleague to a stale version.
 *
 * `relationship_id` CASCADE — the link is meaningless without its relationship, and
 * this MIRRORS the exact cascade `proposals`/`expressions_of_interest` use on their
 * FK to `request_expert_relationships`. `created_by_user_id` / `revoked_by_user_id`
 * RESTRICT — attribution (who shared / who revoked) must survive the actor's own
 * departure (mirrors `expert_referral_invites.invited_by_user_id` and the
 * `audit_events.actor_user_id` treatment). `recipient_email` is stored LOWERCASED by
 * the caller (web layer) — @balo/db never normalises input, so the partial-unique
 * matches on the already-canonicalised value (same contract as
 * `expert_referral_invites.email`).
 *
 * SECURITY: only `token_hash` (SHA-256 hex, 64 chars) is ever persisted — the raw
 * token is returned to the caller ONCE at mint time and NEVER stored or logged.
 *
 * NO RLS: matches the prevailing convention of every table in this package
 * (credit-ledger BAL-376/ADR-1040, party-domains, request-origination) — Balo auths
 * with WorkOS + iron-session, not Supabase Auth, so `auth.uid()` is meaningless;
 * authorization lives in the app/repository layer.
 */
export const proposalShareLinks = pgTable(
  'proposal_share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // The per-expert relationship this share follows. CASCADE (mirrors proposals/EOI).
    relationshipId: uuid('relationship_id')
      .notNull()
      .references(() => requestExpertRelationships.id, { onDelete: 'cascade' }),

    // Recipient colleague's email — stored LOWERCASED by the caller, never here.
    recipientEmail: text('recipient_email').notNull(),

    // SHA-256 hex of the raw token (64 chars). The raw token is NEVER persisted.
    tokenHash: text('token_hash').notNull(),

    // Optional plain-text note from the sharer. Length-capped in the app Zod, not DB.
    note: text('note'),

    // Who minted the share. Preserve attribution → restrict.
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    // Who revoked the share (NULL until revoked). Preserve attribution → restrict.
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),

    // Access window. Defaults to 30 days from mint via a DB-level interval default so
    // the window is correct even if a caller omits `expiresAt`.
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '30 days'`),

    // Set when the link is revoked (manual or superseded by a reshare). NULL = live.
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    // Last time the link resolved a proposal (stamped by `recordAccess`). NULL until
    // first access.
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),

    // Monotonic access counter (bumped by `recordAccess`). CHECK >= 0 below.
    accessCount: integer('access_count').notNull().default(0),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // ONE LIVE link per (relationship, recipient). PARTIAL on live rows only
    // (deleted_at IS NULL AND revoked_at IS NULL) so a revoked/soft-deleted prior
    // frees the slot — the repo's reshare revokes the prior live row BEFORE inserting
    // the new one, vacating this slot (mirrors the proposals resubmit pattern). A
    // NON-partial unique here would silently break reshare after revoke.
    uniqueIndex('proposal_share_link_relationship_recipient_live_idx')
      .on(t.relationshipId, t.recipientEmail)
      .where(sql`${t.deletedAt} IS NULL AND ${t.revokedAt} IS NULL`),

    // Token lookup — UNIQUE and INTENTIONALLY NON-PARTIAL. Tokens are random per
    // issue and never re-created, so there is no soft-delete-recreate collision to
    // dodge; the lookup MUST find the row across live/revoked/expired/deleted states
    // (to distinguish "wrong token" from "revoked/expired token"). Do NOT make partial.
    uniqueIndex('proposal_share_link_token_hash_idx').on(t.tokenHash),

    // FK / list read paths.
    index('proposal_share_link_relationship_idx').on(t.relationshipId),
    index('proposal_share_link_created_by_idx').on(t.createdByUserId),

    check('proposal_share_link_access_count_nonneg', sql`${t.accessCount} >= 0`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const proposalShareLinksRelations = relations(proposalShareLinks, ({ one }) => ({
  relationship: one(requestExpertRelationships, {
    fields: [proposalShareLinks.relationshipId],
    references: [requestExpertRelationships.id],
  }),
  createdBy: one(users, {
    fields: [proposalShareLinks.createdByUserId],
    references: [users.id],
  }),
  revokedBy: one(users, {
    fields: [proposalShareLinks.revokedByUserId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type ProposalShareLink = typeof proposalShareLinks.$inferSelect;
export type NewProposalShareLink = typeof proposalShareLinks.$inferInsert;
