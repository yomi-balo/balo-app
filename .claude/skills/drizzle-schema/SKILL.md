---
name: drizzle-schema
description: Drizzle ORM schema patterns for the Balo platform on Supabase PostgreSQL. Use when creating or modifying database tables, writing migrations, defining relations, adding RLS policies, exporting types, or generating Zod validation schemas. Also use when reviewing schema code, adding indexes, or working with the DBA agent. Covers table conventions, column types, soft deletes, timestamps, UUID primary keys, and multi-tenant design.
---

# Drizzle Schema — Balo Platform

Balo uses Drizzle ORM with Supabase (managed PostgreSQL) via the `postgres-js` driver. Auth is handled by WorkOS (not Supabase Auth) — this affects how RLS policies reference users.

## Quick Reference

### File Locations

```
packages/db/
├── src/
│   ├── schema/              # One file per domain
│   │   ├── enums.ts         # Shared pgEnum definitions
│   │   ├── users.ts         # users table + relations
│   │   ├── companies.ts     # companies, company_members + relations
│   │   ├── agencies.ts      # agencies, agency_members + relations
│   │   ├── experts.ts       # expert_profiles, expert_skills, expert_certifications + relations
│   │   ├── verticals.ts     # verticals, skills, support_types, certifications + relations
│   │   ├── guests.ts        # guest access
│   │   └── index.ts         # Re-exports all schemas
│   ├── repositories/        # Data access layer
│   │   ├── users.ts
│   │   ├── companies.ts
│   │   └── index.ts
│   ├── client.ts            # Drizzle client (postgres-js)
│   └── index.ts             # Package entry point
├── drizzle/                 # Generated migrations (do not edit)
├── drizzle.config.ts        # Drizzle Kit config
└── package.json
```

### Every Table Must Have

```typescript
import { pgTable, uuid, timestamp } from 'drizzle-orm/pg-core';
import { timestamps, softDelete } from './helpers';

export const myTable = pgTable(
  'my_table',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...timestamps,
    ...softDelete,
    // ... your columns
  },
  (t) => [
    // indexes, RLS policies — see references/rls-patterns.md
  ]
);
```

### Shared Column Helpers

Define once in `packages/db/src/schema/helpers.ts`:

```typescript
import { timestamp } from 'drizzle-orm/pg-core';

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => new Date()),
};

export const softDelete = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};
```

**Note:** `{ withTimezone: true }` is required on ALL timestamp columns. This ensures correct handling across timezones (Balo serves users globally).

### Type Exports

Every schema file must export inferred types:

```typescript
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

### Zod Validation

Use `drizzle-zod` for runtime validation schemas:

```typescript
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';

export const insertUserSchema = createInsertSchema(users, {
  email: (schema) => schema.email('Invalid email'),
});
```

## Decision Tree

**Creating a new table?** → Read [references/schema-patterns.md](references/schema-patterns.md)
**Adding RLS policies?** → Read [references/rls-patterns.md](references/rls-patterns.md)
**Defining relations or queries?** → Read [references/relations-queries.md](references/relations-queries.md)
**Adding indexes?** → See Index Rules below

## Conventions

### Naming

| Item            | Convention                             | Example                                           |
| --------------- | -------------------------------------- | ------------------------------------------------- |
| Table names     | snake_case, plural                     | `expert_profiles`                                 |
| Column names    | snake_case                             | `first_name`                                      |
| TypeScript keys | camelCase (auto via config)            | `firstName`                                       |
| Foreign keys    | `{referenced_table_singular}_id`       | `user_id`                                         |
| Enums           | camelCase variable, snake_case DB name | `const caseStatus = pgEnum('case_status', [...])` |
| Schema files    | Domain name                            | `experts.ts`, `verticals.ts`                      |

### Drizzle Config

```typescript
// packages/db/drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

**Note:** No `casing` option — column names are explicitly defined in each schema file (e.g., `text('first_name')`).

### Primary Keys

Always UUID, never serial/integer:

```typescript
id: uuid('id').primaryKey().defaultRandom(),
```

### Foreign Keys

Always explicit with ON DELETE behavior:

```typescript
userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
```

### Index Rules

Add indexes for:

- Every column used in WHERE clauses
- Every column used in JOIN conditions
- Every column used in ORDER BY
- All foreign key columns
- Unique constraints (email, external IDs)

```typescript
import { pgTable, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const experts = pgTable(
  'experts',
  {
    // ... columns
  },
  (t) => [
    index('experts_user_id_idx').on(t.userId),
    uniqueIndex('experts_email_idx').on(t.email),
    // RLS policies also go here
  ]
);
```

### Multi-Tenant Design

Balo will expand beyond Salesforce. Schema rules:

- No column named `salesforce_*` in generic tables
- Use `verticalId` / `vertical_id` for vertical/technology references
- Skill taxonomies go in a separate, configurable table — not hardcoded enums
- Consultant/expert tables are technology-agnostic

## Migration Workflow

**Always use `generate` + `migrate`, never `push` for production.**

RLS policies have known issues with `drizzle-kit push`. Use the generate/migrate flow:

```bash
# After schema changes
pnpm drizzle-kit generate

# Review the generated SQL in drizzle/ folder
# Then apply
pnpm drizzle-kit migrate
```

## What NOT to Do

- ❌ `any` types on schema columns
- ❌ `serial()` or `integer().generatedAlwaysAsIdentity()` for IDs — use `uuid()`
- ❌ Boolean `isDeleted` — use `deletedAt` timestamp
- ❌ Raw SQL queries when Drizzle can express it
- ❌ Forgetting RLS on new tables
- ❌ Forgetting indexes on foreign keys
- ❌ Hardcoding Salesforce-specific concepts in generic tables
- ❌ Using `drizzle-kit push` in production
- ❌ Editing generated migration files
