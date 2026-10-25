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
import { resolveMigrationDatabaseUrl } from './src/migration-database-url';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: resolveMigrationDatabaseUrl(process.env)!,
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

**Always use `generate` + `migrate`. Use `push` only against a local database, never balo-dev or any shared one: it leaves schema the migration tracker doesn't know about, and the next deploy's migrate fails on it.**

### Which database URL drizzle-kit uses

`drizzle.config.ts` takes `MIGRATION_DATABASE_URL`, else `DATABASE_URL` (`src/migration-database-url.ts`), and refuses Supabase's transaction pooler (port 6543). drizzle-kit builds its own postgres-js client with prepared statements on. Through the transaction pooler, a named `COMMIT` in a socket's second transaction is the silent-rollback path `src/client.ts` documents; today's one-transaction migrator doesn't reach it, but an upgrade that commits per migration would. Point `MIGRATION_DATABASE_URL` at the session pooler: the shared `*.pooler.supabase.com` host on port 5432. (Supabase's direct `db.<ref>.supabase.co` host is IPv6-only, which Railway reaches only with outbound IPv6 enabled.) Use the standard form:

```
postgresql://user:password@host:port/database
```

`postgres://` works too. Don't add parameters postgres-js doesn't know, such as `?pgbouncer=true`: it sends them to the server as startup settings, which a direct connection rejects and Supabase's poolers ignore, so a setting like `?options=-c lock_timeout=5s` silently does nothing through a pooler. `sslmode` is fine: postgres-js handles it itself. drizzle-kit also loads `.env` from the working directory without overriding variables that are already set, so `MIGRATION_DATABASE_URL=… pnpm db:migrate` targets that database even when `.env` points elsewhere.

### Migrations run on every API deploy

Railway's pre-deploy step runs `pnpm --filter @balo/db db:migrate` before the new API build takes traffic. Every pending migration applies in ONE transaction:

- If any statement fails, the whole batch rolls back, the deploy fails, and the previous build keeps serving. drizzle-kit prints only the Postgres error, which names the relation, column or constraint: grep the pending `.sql` files for it. Failures that depend on existing rows only reproduce against a copy of the data.
- A migration that succeeds is never undone, even if the new build then fails its healthcheck. **Every migration must work with the build it replaces (expand/contract):** add first, with new columns nullable or defaulted; drop, rename or tighten (NOT NULL, CHECK, UNIQUE) only in a later PR, once no live build (Railway or Vercel) declares the old shape. Drizzle's default reads (`select()` with no field list, `findFirst`/`findMany` without `columns`, `with:`, a bare `returning()`) and every INSERT name each declared column, so dropping a column the old build declares breaks its reads and its writes.
- Retiring a column takes two PRs. PR 1 deletes it from the Drizzle schema without running `db:generate` afterwards; if it is NOT NULL with no default, relax it first (drop `.notNull()` or add a default) and generate that, or the new build's INSERTs fail with `23502`. The snapshot still lists the column, so the next `db:generate` emits the `DROP`: that is PR 2, once PR 1's build is live on Railway and Vercel. A `DROP` that `db:generate` emits unasked is a stop-and-check. BAL-473 deferred `transcripts.recording_ref`'s DROP to BAL-479, but BAL-433's next generate shipped it unasked as 0076.
- The opposite window is open too: Vercel can serve a new web build before the migrate commits. That build's full-row queries name every column it declares, so a column it adds fails its table's queries with `42703` until the migration lands. Where that matters (say, a column on `users`, read on every signed-in request), merge the migration ahead of the web code that declares it.
- A value added by `ALTER TYPE … ADD VALUE` can't be used in the same transaction (`55P04 unsafe use of new value`). CI applies every migration in one Postgres 16 transaction, so a later migration that uses the value fails CI however production split the deploys. A column default is safe through a text cast in the generated SQL: `SET DEFAULT 'x'::text::"public"."your_enum"` (as in 0030). For any other use (backfills, CHECKs, `ADD COLUMN … DEFAULT`, `WHERE`), prove it with `pnpm test:integration` or make the data change outside migrations.
- The migrator silently skips any journal entry whose `when` isn't newer than the last applied migration. `src/invariants/no-migration-is-silently-skipped.test.ts` keeps the journal ordered and numbered. After renumbering a migration in a rebase, regenerate it so its `when` is current, then re-apply any hand edits it carried (a text-cast enum default, a withheld `DROP`): `db:generate` emits neither.

Hand-edit generated SQL only for the cases above, with a comment in the file saying why; otherwise regenerate.

RLS policies have known issues with `drizzle-kit push`. Use the generate/migrate flow:

```bash
# After schema changes, from packages/db
pnpm db:generate

# Review the generated SQL in the drizzle/ folder, then verify it:
# `pnpm test:integration` applies every migration to a throwaway Postgres 16.
# Railway applies merged migrations on deploy. Run `db:migrate` yourself only
# against a local database:
MIGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres pnpm db:migrate
```

## New Repository File Checklist

Every new file added to `packages/db/src/repositories/` **must** ship with a corresponding
`*.integration.test.ts` file in the same PR. This is a hard requirement — SonarQube will
flag the PR if repository files are uncovered.

> Repository coverage comes from `*.integration.test.ts` and counts toward the Sonar gate — see [docs/coverage-policy.md](../../../docs/coverage-policy.md).

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
- ❌ `timestamp('col')` without `{ withTimezone: true }` — always use TIMESTAMPTZ. Use `...timestamps` helper.
- ❌ Raw SQL queries when Drizzle can express it
- ❌ Forgetting RLS on new tables
- ❌ Forgetting indexes on foreign keys
- ❌ Hardcoding Salesforce-specific concepts in generic tables
- ❌ Using `drizzle-kit push` against any shared database (balo-dev included)
- ❌ Editing generated migration files
