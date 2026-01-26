import { pgTable, uuid, text, boolean, integer, timestamp, date, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { expertTypeEnum } from './enums';
import { users } from './users';
import { agencies } from './agencies';
import { verticals, skills, supportTypes, certifications } from './verticals';

export const expertProfiles = pgTable('expert_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  verticalId: uuid('vertical_id').references(() => verticals.id).notNull(),

  type: expertTypeEnum('type').notNull(),
  agencyId: uuid('agency_id').references(() => agencies.id),

  headline: text('headline'),
  bio: text('bio'),
  hourlyRate: integer('hourly_rate'),

  trailheadUrl: text('trailhead_url'),
  linkedinUrl: text('linkedin_url'),
  websiteUrl: text('website_url'),

  availableForWork: boolean('available_for_work').default(true).notNull(),

  cronofyUserId: text('cronofy_user_id'),
  cronofySyncStatus: text('cronofy_sync_status').default('not_connected'),

  stripeConnectId: text('stripe_connect_id'),

  searchable: boolean('searchable').default(true).notNull(),
  skillsLocked: boolean('skills_locked').default(false).notNull(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  approvedAt: timestamp('approved_at'),
}, (table) => ({
  userVerticalIdx: uniqueIndex('expert_user_vertical_idx').on(table.userId, table.verticalId),
}));

export const expertSkills = pgTable('expert_skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  expertProfileId: uuid('expert_profile_id').references(() => expertProfiles.id).notNull(),
  skillId: uuid('skill_id').references(() => skills.id).notNull(),
  supportTypeId: uuid('support_type_id').references(() => supportTypes.id).notNull(),

  proficiency: integer('proficiency').notNull().default(0),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  uniqueSkillIdx: uniqueIndex('expert_skill_unique_idx').on(
    table.expertProfileId,
    table.skillId,
    table.supportTypeId,
  ),
}));

export const expertCertifications = pgTable('expert_certifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  expertProfileId: uuid('expert_profile_id').references(() => expertProfiles.id).notNull(),
  certificationId: uuid('certification_id').references(() => certifications.id).notNull(),

  earnedAt: date('earned_at'),
  expiresAt: date('expires_at'),
  credentialUrl: text('credential_url'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  expertCertIdx: uniqueIndex('expert_cert_unique_idx').on(
    table.expertProfileId,
    table.certificationId,
  ),
}));

// Relations
export const expertProfilesRelations = relations(expertProfiles, ({ one, many }) => ({
  user: one(users, {
    fields: [expertProfiles.userId],
    references: [users.id],
  }),
  vertical: one(verticals, {
    fields: [expertProfiles.verticalId],
    references: [verticals.id],
  }),
  agency: one(agencies, {
    fields: [expertProfiles.agencyId],
    references: [agencies.id],
  }),
  skills: many(expertSkills),
  certifications: many(expertCertifications),
}));

export type ExpertProfile = typeof expertProfiles.$inferSelect;
export type ExpertSkill = typeof expertSkills.$inferSelect;
export type ExpertCertification = typeof expertCertifications.$inferSelect;
