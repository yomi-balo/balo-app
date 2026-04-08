import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { expertProfiles } from './experts';
import { timestamps, softDelete } from './helpers';

// ── Calendar Connections ────────────────────────────────────────

export const calendarConnections = pgTable(
  'calendar_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),
    cronofySub: text('cronofy_sub').notNull(),
    provider: text('provider').notNull(), // 'google' | 'microsoft'
    providerEmail: text('provider_email'),
    accessToken: text('access_token').notNull(), // encrypted AES-256-GCM
    refreshToken: text('refresh_token').notNull(), // encrypted AES-256-GCM
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('connected'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    channelId: text('channel_id'),
    targetCalendarId: text('target_calendar_id'),
    ...timestamps,
    ...softDelete,
  },
  (table) => ({
    expertProfileIdx: uniqueIndex('cal_conn_expert_profile_idx').on(table.expertProfileId),
    cronofySubIdx: index('cal_conn_cronofy_sub_idx').on(table.cronofySub),
    channelIdIdx: index('cal_conn_channel_id_idx').on(table.channelId),
    statusCheck: check(
      'cal_conn_status_check',
      sql`${table.status} IN ('connected', 'sync_pending', 'auth_error')`
    ),
  })
);

// ── Calendar Sub-Calendars ──────────────────────────────────────

export const calendarSubCalendars = pgTable(
  'calendar_sub_calendars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => calendarConnections.id, { onDelete: 'cascade' }),
    calendarId: text('calendar_id').notNull(),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    profileName: text('profile_name'),
    isPrimary: boolean('is_primary').notNull().default(false),
    conflictCheck: boolean('conflict_check').notNull().default(true),
    color: text('color'),
    ...timestamps,
  },
  (table) => ({
    connectionCalendarIdx: uniqueIndex('cal_sub_conn_calendar_idx').on(
      table.connectionId,
      table.calendarId
    ),
    connectionIdx: index('cal_sub_connection_idx').on(table.connectionId),
  })
);

// ── Availability Cache ──────────────────────────────────────────

export const availabilityCache = pgTable('availability_cache', {
  expertProfileId: uuid('expert_profile_id')
    .primaryKey()
    .references(() => expertProfiles.id, { onDelete: 'cascade' }),
  earliestAvailableAt: timestamp('earliest_available_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Relations ───────────────────────────────────────────────────

export const calendarConnectionsRelations = relations(calendarConnections, ({ one, many }) => ({
  expertProfile: one(expertProfiles, {
    fields: [calendarConnections.expertProfileId],
    references: [expertProfiles.id],
  }),
  subCalendars: many(calendarSubCalendars),
}));

export const calendarSubCalendarsRelations = relations(calendarSubCalendars, ({ one }) => ({
  connection: one(calendarConnections, {
    fields: [calendarSubCalendars.connectionId],
    references: [calendarConnections.id],
  }),
}));

export const availabilityCacheRelations = relations(availabilityCache, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [availabilityCache.expertProfileId],
    references: [expertProfiles.id],
  }),
}));

// ── Type exports ────────────────────────────────────────────────

export type CalendarConnection = typeof calendarConnections.$inferSelect;
export type NewCalendarConnection = typeof calendarConnections.$inferInsert;
export type CalendarSubCalendar = typeof calendarSubCalendars.$inferSelect;
export type NewCalendarSubCalendar = typeof calendarSubCalendars.$inferInsert;
export type AvailabilityCache = typeof availabilityCache.$inferSelect;
export type NewAvailabilityCache = typeof availabilityCache.$inferInsert;
