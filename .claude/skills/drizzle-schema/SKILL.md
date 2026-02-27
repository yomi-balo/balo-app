---
name: drizzle-schema
description: Drizzle ORM schema patterns for the Balo platform on Supabase PostgreSQL. Use when creating or modifying database tables, writing migrations, defining relations, adding RLS policies, exporting types, or generating Zod validation schemas. Also use when reviewing schema code, adding indexes, or working with the DBA agent. Covers table conventions, column types, soft deletes, timestamps, UUID primary keys, and multi-tenant design.
---

# Drizzle Schema — Balo Platform

Balo uses Drizzle ORM with Supabase (managed PostgreSQL). Auth is handled by WorkOS (not Supabase Auth) — this affects how RLS policies reference users.

## Quick Reference

### File Locations

```
apps/api/src/db/
├── schema/              # One file per domain
│   ├── users.ts
│   ├── cases.ts
│   ├── experts.ts
│   └── index.ts         # Re-exports all schemas
├── relations.ts         # All Drizzle relations
├── client.ts            # DB client (admin + RLS)
└── migrate.ts           # Migration runner
drizzle/                 # Generated migrations (do not edit)
drizzle.config.ts        # Drizzle Kit config
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
    // RLS policies — see references/rls-patterns.md
  ]
);
```

### Shared Column Helpers

Define once in `apps/api/src/db/schema/helpers.ts`:

```typescript
import { timestamp } from 'drizzle-orm/pg-core';

export const timestamps = {
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdateFn(() => new Date()),
};

export const softDelete = {
  deletedAt: timestamp('deleted_at'),
};
```

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
| Schema files    | kebab-case or domain name              | `expert-profiles.ts`                              |

### Drizzle Config

```typescript
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './apps/api/src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  migrations: {
    prefix: 'supabase',
  },
});
```

The `casing: 'snake_case'` setting means you write camelCase in TypeScript and Drizzle automatically maps to snake_case in the database.

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
- Use `technology_id` or `vertical_id` for category references
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
