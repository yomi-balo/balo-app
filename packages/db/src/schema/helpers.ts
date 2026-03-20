import { timestamp } from 'drizzle-orm/pg-core';

/**
 * Standard timestamp columns for every table.
 *
 * Always use { withTimezone: true } — this maps to TIMESTAMPTZ in Postgres,
 * which stores values as UTC internally. Plain timestamp() (TIMESTAMP WITHOUT
 * TIME ZONE) is ambiguous and causes silent bugs when servers or users span
 * timezones. TIMESTAMPTZ is always the right choice for any point-in-time value.
 *
 * Usage: spread into every table definition
 *   export const myTable = pgTable('my_table', {
 *     id: uuid('id').primaryKey().defaultRandom(),
 *     ...timestamps,
 *   });
 */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => new Date()),
};

/**
 * Soft delete column.
 *
 * Use deletedAt (timestamp) not isDeleted (boolean) — a timestamp captures
 * *when* it was deleted, which is useful for auditing and TTL cleanup jobs.
 *
 * IMPORTANT: Every query on a soft-deletable table must filter with:
 *   .where(isNull(table.deletedAt))
 * RLS policies also filter this — but Drizzle queries must guard it too.
 */
export const softDelete = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};
