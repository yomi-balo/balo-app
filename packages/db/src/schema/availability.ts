import { pgTable, uuid, integer, time, text, date, index, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { expertProfiles } from './experts';
import { timestamps, softDelete } from './helpers';

/**
 * Recurring weekly availability windows owned by an expert.
 *
 * Times are stored as wall-clock values in the expert's own timezone
 * (`expert_profiles.timezone`) — never as UTC instants. The resolver
 * expands these per-date into UTC for DST correctness.
 *
 * Soft-deletable. The schedule editor (BAL-195) owns mutations; BAL-243
 * only reads.
 */
export const availabilityRules = pgTable(
  'availability_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),
    // 0 = Sunday, 6 = Saturday (matches JS Date#getDay)
    dayOfWeek: integer('day_of_week').notNull(),
    // Local wall-clock time in the expert's timezone (Postgres `time`).
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    ...timestamps,
    ...softDelete,
  },
  // Note: no unique constraint on (expert, day, start) — overlapping rules are
  // allowed in v1; the resolver merges windows. BAL-195's schedule editor may
  // tighten this later if needed.
  (table) => [
    index('avail_rules_expert_profile_idx').on(table.expertProfileId),
    index('avail_rules_expert_day_idx').on(table.expertProfileId, table.dayOfWeek),
    check('avail_rules_day_check', sql`${table.dayOfWeek} BETWEEN 0 AND 6`),
    // BAL-234: start != end (a zero-length window is meaningless). `end < start`
    // is a valid window that CROSSES MIDNIGHT into the following date; `dayOfWeek`
    // anchors the START. The resolver expands the end from the next date. The
    // editor/API still author same-day ranges only — the crossing UI is BAL-415.
    check('avail_rules_start_ne_end_check', sql`${table.startTime} <> ${table.endTime}`),
  ]
);

export const availabilityRulesRelations = relations(availabilityRules, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [availabilityRules.expertProfileId],
    references: [expertProfiles.id],
  }),
}));

export type AvailabilityRule = typeof availabilityRules.$inferSelect;
export type NewAvailabilityRule = typeof availabilityRules.$inferInsert;

/**
 * Full-day date-off blocks (holidays / leave) owned by an expert — BAL-235.
 *
 * Stores an end-INCLUSIVE `[startDate, endDate]` calendar-date range in the
 * expert's OWN timezone (`expert_profiles.timezone`); a single-day block has
 * `startDate === endDate`. These are calendar dates, not moments, so they use
 * Postgres `date` (Drizzle maps `date` → JS string 'YYYY-MM-DD') — never a
 * `timestamp`. The availability resolver expands each range into whole UTC days
 * via `fromZonedTime` + the expert timezone (server-side) and subtracts them
 * (as ordinary busy intervals) from the weekly-rule windows, so blocked days
 * never surface as bookable.
 *
 * Soft-deletable. Mutations come from the settings "Time off" card via the
 * server-action → internal-Fastify → repo path; the resolver only reads.
 *
 * No RLS — deliberately mirrors the sibling `availability_rules` (and
 * `availability_cache` / `calendar_connections`): the whole availability domain
 * is admin-client-only behind WorkOS / `requireInternalAuth`. Adding RLS to one
 * table of the domain would be drift; a domain-wide hardening ticket is deferred.
 *
 * No actor / attribution columns (no `created_by` / `deleted_by`) — a deliberate,
 * documented domain exemption, not an oversight, mirroring the sibling
 * `availability_rules`. Today only the owning expert mutates their OWN time off
 * via a session-derived `expertProfileId`, so the actor is unambiguous without a
 * recorded column (ADR-1029). If an admin "manage expert time off" capability
 * ships later (multiple possible actors), add `deleted_by` then.
 */
export const availabilityOverrides = pgTable(
  'availability_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),
    // Calendar dates (no time) in the expert's OWN timezone. End-INCLUSIVE:
    // a single-day block has startDate === endDate. Drizzle `date` → 'YYYY-MM-DD'.
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    // Optional free-text reason ("Holiday", "Annual leave"). Nullable.
    label: text('label'),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    // FK + per-expert lookups.
    index('avail_overrides_expert_profile_idx').on(table.expertProfileId),
    // Serves the listUpcoming filter (endDate >= today) per expert.
    index('avail_overrides_expert_end_idx').on(table.expertProfileId, table.endDate),
    // Serves the "upcoming, sorted by start" ORDER BY.
    index('avail_overrides_expert_start_idx').on(table.expertProfileId, table.startDate),
    // Single-day (=) or forward range only. Mirrors avail_rules_start_before_end_check.
    check('avail_overrides_start_before_end_check', sql`${table.startDate} <= ${table.endDate}`),
  ]
);

export const availabilityOverridesRelations = relations(availabilityOverrides, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [availabilityOverrides.expertProfileId],
    references: [expertProfiles.id],
  }),
}));

export type AvailabilityOverride = typeof availabilityOverrides.$inferSelect;
export type NewAvailabilityOverride = typeof availabilityOverrides.$inferInsert;

// NOTE: No `createInsertSchema` / `drizzle-zod` export here. `drizzle-zod` is NOT
// a dependency of @balo/db and no existing schema file uses it (see the same note
// in `credit-wallets.ts` and `project-requests.ts`). Input validation for time-off
// blocks — the label max(80), the YYYY-MM-DD date format, and the
// `endDate >= startDate` cross-field refine — lives in the Fastify route's own Zod
// schema (`apps/api/src/routes/experts/availability-overrides.ts`) and the web
// server action. The `notNull()` columns, the `date` types, and the
// `avail_overrides_start_before_end_check` CHECK are the persistence-layer contract.
