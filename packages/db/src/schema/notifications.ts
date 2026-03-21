import { pgTable, uuid, varchar, text, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    event: varchar('event', { length: 100 }).notNull(),
    correlationId: uuid('correlation_id').notNull(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 20 }).notNull(),
    template: varchar('template', { length: 100 }).notNull(),
    status: varchar('status', { length: 20 }).notNull(), // 'sent' | 'failed' | 'skipped'
    error: text('error'),
    metadata: jsonb('metadata'),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('notification_log_correlation_id_idx').on(table.correlationId),
    index('notification_log_recipient_id_idx').on(table.recipientId),
    index('notification_log_created_at_idx').on(table.createdAt),
    index('notification_log_event_status_idx').on(table.event, table.status),
  ]
);

export type NotificationLog = typeof notificationLog.$inferSelect;
export type NewNotificationLog = typeof notificationLog.$inferInsert;
