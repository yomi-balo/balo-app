import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { expertProfiles } from './experts';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * expert_referral_invites (BAL-325) — an approved expert referring a peer into the
 * marketplace by email. One row per (expert, invitee-email): the referrer's own
 * "invite a colleague" action. Distinct from `request_expert_relationships`
 * (admin invites an existing expert onto a specific project request) — this is a
 * top-of-funnel referral, keyed only on a raw email that may not yet map to a user.
 *
 * `expertProfileId` CASCADE (the referral is meaningless without the referrer's
 * profile); `invitedByUserId` RESTRICT (preserve referrer attribution for future
 * conversion credit — mirrors the `invited_by_user_id` treatment on
 * `request_expert_relationships`). `email` is stored LOWERCASED by the caller —
 * @balo/db never normalises input; the partial unique index therefore matches on
 * the already-canonicalised value.
 */
export const expertReferralInvites = pgTable(
  'expert_referral_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),
    // Invitee's email — stored lowercased by the caller (web layer), never here.
    email: text('email').notNull(),
    // The referring expert's user. Preserve attribution → restrict.
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    invitedAt: timestamp('invited_at', { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // One LIVE invite per (expert, email). PARTIAL on `deleted_at IS NULL`
    // (mirrors `request_expert_relationship_unique_idx`) so a withdrawn
    // (soft-deleted) invite frees the slot and the same email can be re-invited,
    // while a live duplicate is still rejected. A NON-partial unique here would
    // silently break re-create after soft-delete — this predicate is load-bearing
    // and the repo's `claim` ON CONFLICT arbiter must restate it exactly.
    uniqueIndex('expert_referral_invite_unique_idx')
      .on(t.expertProfileId, t.email)
      .where(sql`${t.deletedAt} IS NULL`),
    index('expert_referral_invite_expert_idx').on(t.expertProfileId),
    index('expert_referral_invite_invited_by_idx').on(t.invitedByUserId),
    // Future conversion-attribution join (invitee signs up with this email).
    index('expert_referral_invite_email_idx').on(t.email),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const expertReferralInvitesRelations = relations(expertReferralInvites, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [expertReferralInvites.expertProfileId],
    references: [expertProfiles.id],
  }),
  invitedBy: one(users, {
    fields: [expertReferralInvites.invitedByUserId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type ExpertReferralInvite = typeof expertReferralInvites.$inferSelect;
export type NewExpertReferralInvite = typeof expertReferralInvites.$inferInsert;
