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
│   │   ├── experts.ts
│   │   └── index.ts
│   ├── test/                       # Integration test infrastructure
│   │   ├── global-setup.ts         # Testcontainers lifecycle (Postgres 16 + migrations)
│   │   ├── setup-integration.ts    # Per-test Drizzle transaction wrapper (auto-rollback)
│   │   ├── test-client.ts          # postgres-js + Drizzle client (max:1 pool)
│   │   └── factories/              # userFactory, expertFactory, expertDraftFactory
│   ├── client.ts            # Drizzle client (postgres-js)
│   └── index.ts             # Package entry point
├── drizzle/                 # Generated migrations (do not edit)
├── drizzle.config.ts        # Drizzle Kit config
└── package.json
```

### Package Imports

```typescript
// Schema types and table definitions
import { users, experts } from '@balo/db/schema';

// Drizzle client
import { db } from '@balo/db';

// Repositories (data access layer)
import { userRepository } from '@balo/db/repositories';
```

The package name is `@balo/db`. Import from `@balo/db/schema` for table definitions and types, `@balo/db` for the Drizzle client.

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

**Warning:** `$onUpdateFn(() => new Date())` only fires through Drizzle ORM calls. If anything bypasses Drizzle (raw SQL, Supabase dashboard edits, direct migrations), `updatedAt` will silently stay stale. For critical tables, back this up with a DB-level trigger:

```sql
-- Add to the migration SQL after generating:
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
BEFORE UPDATE ON my_table
FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

### Enums

Define enums at module level in `schema/enums.ts`, then import them in the table file:

```typescript
import { pgEnum } from 'drizzle-orm/pg-core';

export const caseStatus = pgEnum('case_status', [
  'pending',
  'active',
  'resolved',
  'cancelled',
]);

// In the table:
status: caseStatus('status').default('pending').notNull(),
```

For full enum patterns and a complete table example → see [references/schema-patterns.md](references/schema-patterns.md).

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

// Use createInsertSchema for API input validation (POST/PUT bodies)
export const insertUserSchema = createInsertSchema(users, {
  email: (schema) => schema.email('Invalid email'),
});

// Use createSelectSchema when you need to validate/parse data coming OUT of the DB
// (e.g. serialising to API responses, validating third-party data before storing)
export const selectUserSchema = createSelectSchema(users);
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

### Soft Delete Query Rule

**Always filter deleted records in queries.** The `deletedAt` column is only useful if every query guards against it:

```typescript
import { isNull } from 'drizzle-orm';

// ✅ Correct — excludes soft-deleted rows
const active = await db.select().from(users).where(isNull(users.deletedAt));

// ❌ Wrong — returns deleted records too
const all = await db.select().from(users);
```

Add `isNull(table.deletedAt)` to every query on soft-deletable tables. Helper for combining conditions:

```typescript
import { and, isNull, eq } from 'drizzle-orm';

const user = await db
  .select()
  .from(users)
  .where(and(isNull(users.deletedAt), eq(users.id, userId)));
```

### Multi-Tenant Design

Balo will expand beyond Salesforce. Schema rules:

- No column named `salesforce_*` in generic tables
- Use `verticalId` / `vertical_id` for vertical/technology references
- Skill taxonomies go in a separate, configurable table — not hardcoded enums
- Consultant/expert tables are technology-agnostic

## WorkOS + RLS: The Key Pattern

Standard Supabase RLS uses `auth.uid()`. Balo uses WorkOS — RLS works differently. **Summary:**

- The **admin client** (`db`) bypasses RLS. Use it in Fastify routes, Server Actions, webhooks, and jobs where WorkOS has already verified the user.
- RLS provides defense-in-depth as a second layer. Set user context via transaction-scoped variables when DB-level enforcement is needed.
- **Never** use `auth.uid()` in Balo RLS policies — it will always be null. Use `current_setting('app.current_user_id', true)::uuid` instead.

```typescript
// Inline policy example:
pgPolicy('users_select_own', {
  for: 'select',
  using: sql`id = current_setting('app.current_user_id', true)::uuid`,
}),
```

For full RLS setup, client patterns, and all policy examples → see [references/rls-patterns.md](references/rls-patterns.md).

## Relations: Minimal Example

```typescript
import { relations } from 'drizzle-orm';

// In users.ts — relations co-located with their table
export const usersRelations = relations(users, ({ many }) => ({
  companyMemberships: many(companyMembers), // one-to-many
}));

// In companyMembers.ts
export const companyMembersRelations = relations(companyMembers, ({ one }) => ({
  user: one(users, { fields: [companyMembers.userId], references: [users.id] }),
  company: one(companies, { fields: [companyMembers.companyId], references: [companies.id] }),
}));
```

For full relation patterns and the `.query` API → see [references/relations-queries.md](references/relations-queries.md).

## Migration Workflow

**Always use `generate` + `migrate`, never `push` for production.**

### DATABASE_URL Format

`postgres-js` requires the standard Postgres connection string format:

```
postgresql://user:password@host:port/database
```

Railway sometimes generates a `postgres://` URL (vs `postgresql://`) — these are equivalent and both work. However, Railway may also generate a **pooled** connection string that includes `?pgbouncer=true&connection_limit=1` — strip those parameters for the Drizzle migration client, which needs a direct connection.

### If a Migration Fails Mid-Way on Railway

Drizzle migrations are transactional — if the SQL errors, the transaction is rolled back automatically. However if a migration partially succeeds outside a transaction:

1. Fix the schema error in the migration file (or delete and regenerate)
2. Connect to the DB directly and manually roll back the partial change
3. Re-run `pnpm drizzle-kit migrate`

Do not edit generated migration files for new changes — always regenerate.

RLS policies have known issues with `drizzle-kit push`. Use the generate/migrate flow:

```bash
# After schema changes
pnpm drizzle-kit generate

# Review the generated SQL in drizzle/ folder
# Then apply
pnpm drizzle-kit migrate
```

## New Repository File Checklist

Every new file added to `packages/db/src/repositories/` **must** ship with a corresponding
`*.integration.test.ts` file in the same PR. This is a hard requirement — SonarQube will
flag the PR if repository files are uncovered.

1. Create `{name}.integration.test.ts` alongside the repository file
2. Use factories from `packages/db/src/test/factories/` to seed test data
3. Transaction rollback is handled globally — no `cleanTables()` or manual teardown
4. Cover each exported function: at minimum happy path + key error/edge case
5. Run locally with `pnpm test:integration` (requires Docker)

See `.claude/skills/testing/SKILL.md` → "Database Integration Tests" for the full pattern.

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
