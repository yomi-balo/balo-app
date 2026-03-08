import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  date,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { expertTypeEnum, applicationStatusEnum, languageProficiencyEnum } from './enums';
import { users } from './users';
import { agencies } from './agencies';
import { verticals, skills, supportTypes, certifications } from './verticals';
import { languages } from './languages';
import { industries } from './industries';
import { expertPayoutDetails } from './payouts';

export const expertProfiles = pgTable(
  'expert_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id)
      .notNull(),
    verticalId: uuid('vertical_id')
      .references(() => verticals.id)
      .notNull(),

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

    searchable: boolean('searchable').default(false).notNull(),
    skillsLocked: boolean('skills_locked').default(false).notNull(),

    // Experience metrics
    yearStartedSalesforce: integer('year_started_salesforce'),
    // Stores the lower bound of the selected range.
    // UI ranges → stored value: None=0, 1-9=1, 10-25=10, 26-50=26, 50+=50
    // Display logic maps the stored value back to the range label.
    projectCountMin: integer('project_count_min'),
    projectLeadCountMin: integer('project_lead_count_min'),

    // Salesforce distinctions
    isSalesforceMvp: boolean('is_salesforce_mvp').default(false).notNull(),
    isSalesforceCta: boolean('is_salesforce_cta').default(false).notNull(),
    isCertifiedTrainer: boolean('is_certified_trainer').default(false).notNull(),

    // Application lifecycle
    applicationStatus: applicationStatusEnum('application_status').default('draft').notNull(),
    submittedAt: timestamp('submitted_at'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    approvedAt: timestamp('approved_at'),
  },
  (table) => ({
    userVerticalIdx: uniqueIndex('expert_user_vertical_idx').on(table.userId, table.verticalId),
  })
);

export const expertSkills = pgTable(
  'expert_skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .references(() => expertProfiles.id)
      .notNull(),
    skillId: uuid('skill_id')
      .references(() => skills.id)
      .notNull(),
    supportTypeId: uuid('support_type_id')
      .references(() => supportTypes.id)
      .notNull(),

    proficiency: integer('proficiency').notNull().default(0),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueSkillIdx: uniqueIndex('expert_skill_unique_idx').on(
      table.expertProfileId,
      table.skillId,
      table.supportTypeId
    ),
  })
);

export const expertCertifications = pgTable(
  'expert_certifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .references(() => expertProfiles.id)
      .notNull(),
    certificationId: uuid('certification_id')
      .references(() => certifications.id)
      .notNull(),

    earnedAt: date('earned_at'),
    expiresAt: date('expires_at'),
    credentialUrl: text('credential_url'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    expertCertIdx: uniqueIndex('expert_cert_unique_idx').on(
      table.expertProfileId,
      table.certificationId
    ),
  })
);

export const expertLanguages = pgTable(
  'expert_languages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .references(() => expertProfiles.id, { onDelete: 'cascade' })
      .notNull(),
    languageId: uuid('language_id')
      .references(() => languages.id, { onDelete: 'restrict' })
      .notNull(),

    proficiency: languageProficiencyEnum('proficiency').notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    expertLangUniqueIdx: uniqueIndex('expert_lang_unique_idx').on(
      table.expertProfileId,
      table.languageId
    ),
    expertProfileIdx: index('expert_lang_profile_idx').on(table.expertProfileId),
    languageIdx: index('expert_lang_language_idx').on(table.languageId),
  })
);

export const expertIndustries = pgTable(
  'expert_industries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .references(() => expertProfiles.id, { onDelete: 'cascade' })
      .notNull(),
    industryId: uuid('industry_id')
      .references(() => industries.id, { onDelete: 'restrict' })
      .notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    expertIndustryUniqueIdx: uniqueIndex('expert_industry_unique_idx').on(
      table.expertProfileId,
      table.industryId
    ),
    expertProfileIdx: index('expert_industry_profile_idx').on(table.expertProfileId),
    industryIdx: index('expert_industry_industry_idx').on(table.industryId),
  })
);

export const workHistory = pgTable(
  'work_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .references(() => expertProfiles.id, { onDelete: 'cascade' })
      .notNull(),

    role: text('role').notNull(),
    company: text('company').notNull(),
    startedAt: timestamp('started_at').notNull(),
    endedAt: timestamp('ended_at'),
    isCurrent: boolean('is_current').default(false).notNull(),
    responsibilities: text('responsibilities'),

    sortOrder: integer('sort_order').default(0).notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    expertProfileIdx: index('work_history_profile_idx').on(table.expertProfileId),
    sortIdx: index('work_history_sort_idx').on(table.expertProfileId, table.sortOrder),
  })
);

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
  languages: many(expertLanguages),
  industries: many(expertIndustries),
  workHistory: many(workHistory),
  payoutDetails: one(expertPayoutDetails, {
    fields: [expertProfiles.id],
    references: [expertPayoutDetails.expertProfileId],
  }),
}));

export const expertSkillsRelations = relations(expertSkills, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [expertSkills.expertProfileId],
    references: [expertProfiles.id],
  }),
  skill: one(skills, {
    fields: [expertSkills.skillId],
    references: [skills.id],
  }),
  supportType: one(supportTypes, {
    fields: [expertSkills.supportTypeId],
    references: [supportTypes.id],
  }),
}));

export const expertCertificationsRelations = relations(expertCertifications, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [expertCertifications.expertProfileId],
    references: [expertProfiles.id],
  }),
  certification: one(certifications, {
    fields: [expertCertifications.certificationId],
    references: [certifications.id],
  }),
}));

export const expertLanguagesRelations = relations(expertLanguages, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [expertLanguages.expertProfileId],
    references: [expertProfiles.id],
  }),
  language: one(languages, {
    fields: [expertLanguages.languageId],
    references: [languages.id],
  }),
}));

export const expertIndustriesRelations = relations(expertIndustries, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [expertIndustries.expertProfileId],
    references: [expertProfiles.id],
  }),
  industry: one(industries, {
    fields: [expertIndustries.industryId],
    references: [industries.id],
  }),
}));

export const workHistoryRelations = relations(workHistory, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [workHistory.expertProfileId],
    references: [expertProfiles.id],
  }),
}));

export type ExpertProfile = typeof expertProfiles.$inferSelect;
export type NewExpertProfile = typeof expertProfiles.$inferInsert;
export type ExpertSkill = typeof expertSkills.$inferSelect;
export type NewExpertSkill = typeof expertSkills.$inferInsert;
export type ExpertCertification = typeof expertCertifications.$inferSelect;
export type NewExpertCertification = typeof expertCertifications.$inferInsert;
export type ExpertLanguage = typeof expertLanguages.$inferSelect;
export type NewExpertLanguage = typeof expertLanguages.$inferInsert;
export type ExpertIndustry = typeof expertIndustries.$inferSelect;
export type NewExpertIndustry = typeof expertIndustries.$inferInsert;
export type WorkHistory = typeof workHistory.$inferSelect;
export type NewWorkHistory = typeof workHistory.$inferInsert;
