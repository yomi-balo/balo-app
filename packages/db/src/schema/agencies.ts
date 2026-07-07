import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import {
  agencyRoleEnum,
  domainJoinModeEnum,
  membershipAuthorityEnum,
  joinMethodEnum,
} from './enums';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

export const agencies = pgTable('agencies', {
  id: uuid('id').primaryKey().defaultRandom(),

  name: text('name').notNull(),
  slug: text('slug').unique(),
  logoUrl: text('logo_url'),

  stripeConnectId: text('stripe_connect_id'),

  // BAL-345: domain auto-join governance — symmetric with `companies`. Built for
  // symmetry; the agency path has no v1 runtime trigger (forward-compat only).
  domainJoinMode: domainJoinModeEnum('domain_join_mode').notNull().default('auto'),
  membershipAuthority: membershipAuthorityEnum('membership_authority').notNull().default('balo'),

  ...timestamps,
});

export const agencyMembers = pgTable(
  'agency_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agencyId: uuid('agency_id')
      .references(() => agencies.id)
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id)
      .notNull(),

    role: agencyRoleEnum('role').notNull().default('expert'),

    // BAL-345: how this membership originated (symmetric with company_members).
    joinMethod: joinMethodEnum('join_method').notNull().default('personal_workspace'),

    invitedById: uuid('invited_by_id').references(() => users.id),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),

    // BAL-345: soft-delete + attribution (ADR-1030), symmetric with company_members.
    ...softDelete,
    // ON DELETE RESTRICT (not CASCADE/SET NULL). Safe in v1 ONLY because the escape
    // hatch is SELF-removal (deletedByUserId === the row's own userId), so on a
    // user hard-delete this column cascades away WITH the user. The first
    // ADMIN-removal path (a different actor as deleter) will require a delete-user
    // anonymization/null phase for this column before RESTRICT can be honoured.
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => ({
    // PARTIAL on `deleted_at IS NULL` (BAL-345), symmetric with company_user_idx.
    agencyUserIdx: uniqueIndex('agency_user_idx')
      .on(table.agencyId, table.userId)
      .where(sql`${table.deletedAt} IS NULL`),
  })
);

// Relations
export const agenciesRelations = relations(agencies, ({ many }) => ({
  members: many(agencyMembers),
}));

export const agencyMembersRelations = relations(agencyMembers, ({ one }) => ({
  agency: one(agencies, {
    fields: [agencyMembers.agencyId],
    references: [agencies.id],
  }),
  user: one(users, {
    fields: [agencyMembers.userId],
    references: [users.id],
  }),
}));

export type Agency = typeof agencies.$inferSelect;
export type NewAgency = typeof agencies.$inferInsert;
export type AgencyMember = typeof agencyMembers.$inferSelect;
