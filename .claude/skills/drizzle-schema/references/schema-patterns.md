# Schema Patterns — Balo

## Complete Table Example

```typescript
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { pgPolicy } from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { timestamps, softDelete } from './helpers';

// Enum definition
export const userRole = pgEnum('user_role', ['client', 'expert']);

// Table definition
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workosUserId: varchar('workos_user_id', { length: 255 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    role: userRole('role').notNull(),
    onboardingCompleted: boolean('onboarding_completed').default(false).notNull(),
    avatarUrl: text('avatar_url'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('users_workos_id_idx').on(t.workosUserId),
    uniqueIndex('users_email_idx').on(t.email),
    index('users_role_idx').on(t.role),
    // RLS policies — see rls-patterns.md
  ]
);

// Type exports
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// Zod validation
export const insertUserSchema = createInsertSchema(users, {
  email: (schema) => schema.email('Invalid email format'),
  firstName: (schema) => schema.min(1, 'First name is required'),
});

export const selectUserSchema = createSelectSchema(users);
```

## Column Type Guide

### Strings

```typescript
// Short strings with max length (names, titles)
firstName: varchar('first_name', { length: 255 }),

// Emails (RFC 5321 max is 320 chars)
email: varchar('email', { length: 320 }).notNull(),

// Long text (descriptions, bios)
bio: text('bio'),

// External IDs from third parties
workosUserId: varchar('workos_user_id', { length: 255 }).notNull(),
stripeAccountId: varchar('stripe_account_id', { length: 255 }),
```

### Numbers

```typescript
// Currency amounts — store in cents as integer
amountCents: integer('amount_cents').notNull(),

// Rates (use integer cents, not decimal)
hourlyRateCents: integer('hourly_rate_cents'),

// Counts
totalSessions: integer('total_sessions').default(0).notNull(),

// For decimal precision (ratings)
import { numeric } from 'drizzle-orm/pg-core';
averageRating: numeric('average_rating', { precision: 3, scale: 2 }),
```

### Booleans

```typescript
isActive: boolean('is_active').default(true).notNull(),
onboardingCompleted: boolean('onboarding_completed').default(false).notNull(),
```

### JSON

```typescript
import { jsonb } from 'drizzle-orm/pg-core';

// Structured metadata
metadata: jsonb('metadata').$type<{
  source?: string;
  referralCode?: string;
}>(),

// Preferences
preferences: jsonb('preferences').$type<UserPreferences>().default({}),
```

**Rule:** Always type your JSONB columns with `$type<T>()`.

### Dates & Times

```typescript
// Timestamps (most common)
scheduledAt: timestamp('scheduled_at').notNull(),
expiresAt: timestamp('expires_at'),

// Date only (no time component)
import { date } from 'drizzle-orm/pg-core';
dateOfBirth: date('date_of_birth'),

// Duration in minutes (store as integer)
durationMinutes: integer('duration_minutes').notNull(),
```

### Enums

```typescript
// Define enum OUTSIDE the table
export const caseStatus = pgEnum('case_status', [
  'pending',
  'active',
  'resolved',
  'cancelled',
]);

// Use in table
status: caseStatus('status').default('pending').notNull(),
```

**Rule:** Define enums at module level, not inline. Export them for reuse.

## Domain-Specific Table Patterns

### Join Tables (Many-to-Many)

```typescript
export const caseParticipants = pgTable(
  'case_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: participantRole('role').notNull(),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
  },
  (t) => [
    index('case_participants_case_id_idx').on(t.caseId),
    index('case_participants_user_id_idx').on(t.userId),
    uniqueIndex('case_participants_unique').on(t.caseId, t.userId),
  ]
);
```

### Wallet / Credit System

```typescript
export const creditWallets = pgTable(
  'credit_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id)
      .unique(),
    balanceCents: integer('balance_cents').default(0).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('credit_wallets_user_id_idx').on(t.userId)]
);

export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => creditWallets.id),
    amountCents: integer('amount_cents').notNull(), // positive = credit, negative = debit
    type: transactionType('type').notNull(),
    referenceId: uuid('reference_id'), // case_id, package_id, etc.
    referenceType: varchar('reference_type', { length: 50 }),
    description: text('description'),
    ...timestamps,
  },
  (t) => [
    index('credit_tx_wallet_id_idx').on(t.walletId),
    index('credit_tx_reference_idx').on(t.referenceId, t.referenceType),
  ]
);
```

### Configurable Taxonomy (Multi-Vertical Ready)

```typescript
// Technology-agnostic skill categories
export const skillCategories = pgTable(
  'skill_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verticalId: uuid('vertical_id')
      .notNull()
      .references(() => verticals.id),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 255 }).notNull(),
    parentId: uuid('parent_id'), // self-referencing for hierarchy
    sortOrder: integer('sort_order').default(0).notNull(),
    ...timestamps,
  },
  (t) => [
    index('skill_categories_vertical_idx').on(t.verticalId),
    uniqueIndex('skill_categories_slug_vertical_idx').on(t.slug, t.verticalId),
  ]
);

// Verticals (Salesforce, Microsoft, Adobe, etc.)
export const verticals = pgTable('verticals', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  isActive: boolean('is_active').default(true).notNull(),
  ...timestamps,
});
```

## Schema File Organization

One file per domain. Re-export everything from index.ts:

```typescript
// apps/api/src/db/schema/index.ts
export * from './helpers';
export * from './users';
export * from './experts';
export * from './cases';
export * from './payments';
export * from './chat';
```

Keep files focused:

- `users.ts` — users, user preferences
- `experts.ts` — expert profiles, certifications, availability
- `cases.ts` — cases, case participants, case messages
- `payments.ts` — wallets, transactions, invoices
- `chat.ts` — messages, attachments

## Zod Schema Patterns

```typescript
import { createInsertSchema } from 'drizzle-zod';
import { z } from 'zod';

// Basic — auto-generated from Drizzle schema
export const insertCaseSchema = createInsertSchema(cases);

// With overrides — add stricter validation
export const insertCaseSchema = createInsertSchema(cases, {
  title: (schema) => schema.min(3, 'Title must be at least 3 characters').max(200),
  description: (schema) => schema.max(5000),
});

// With business logic
export const createCaseRequestSchema = insertCaseSchema
  .omit({ id: true, createdAt: true, updatedAt: true, deletedAt: true })
  .extend({
    participantIds: z.array(z.string().uuid()).min(1, 'At least one participant required'),
  });
```

## Checklist for New Tables

- [ ] UUID primary key with `defaultRandom()`
- [ ] `...timestamps` spread
- [ ] `...softDelete` spread (if applicable)
- [ ] All foreign keys have explicit `onDelete` behavior
- [ ] Indexes on all foreign key columns
- [ ] Indexes on columns used in WHERE/ORDER BY
- [ ] Unique constraints where needed
- [ ] RLS policies defined (see rls-patterns.md)
- [ ] Types exported (`$inferSelect` and `$inferInsert`)
- [ ] Zod schemas exported for API validation
- [ ] No Salesforce-specific naming in generic tables
- [ ] Migration generated with `drizzle-kit generate`
- [ ] Migration SQL reviewed before applying
