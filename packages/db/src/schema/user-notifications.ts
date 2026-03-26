import { pgTable, uuid, varchar, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

export const userNotifications = pgTable(
  'user_notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    event: varchar('event', { length: 100 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    body: text('body'),
    actionUrl: varchar('action_url', { length: 500 }),
    metadata: jsonb('metadata'),
    readAt: timestamp('read_at', { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('user_notifications_user_id_read_at_idx').on(table.userId, table.readAt),
    index('user_notifications_user_created_idx').on(table.userId, table.createdAt),
    index('user_notifications_created_at_idx').on(table.createdAt),
  ]
);

export const userNotificationsRelations = relations(userNotifications, ({ one }) => ({
  user: one(users, { fields: [userNotifications.userId], references: [users.id] }),
}));

export type UserNotification = typeof userNotifications.$inferSelect;
export type NewUserNotification = typeof userNotifications.$inferInsert;
