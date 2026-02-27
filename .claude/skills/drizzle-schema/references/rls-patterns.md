# RLS Patterns — Balo

## Important: Balo Uses WorkOS, Not Supabase Auth

Standard Supabase RLS examples use `auth.uid()` and `auth.jwt()`. Balo uses WorkOS for authentication, so RLS policies work differently.

**Balo's approach:**

1. API requests are authenticated by WorkOS middleware in Fastify
2. Server-side code uses the **admin client** (bypasses RLS) for trusted operations
3. RLS provides defense-in-depth — a second layer if queries somehow reach Supabase directly
4. User context is set via transaction-scoped variables when RLS is needed

## DB Client Setup

```typescript
// apps/api/src/db/client.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

// Admin client — bypasses RLS. Use in Fastify API routes (already authed by WorkOS).
const adminConnection = postgres(connectionString, { prepare: false });
export const db = drizzle(adminConnection, { schema, casing: 'snake_case' });

// RLS client — respects RLS policies. Use when user context must be enforced at DB level.
const rlsConnection = postgres(connectionString, { prepare: false });
export const rlsDb = drizzle(rlsConnection, { schema, casing: 'snake_case' });
```

**When to use which:**

- `db` (admin): Fastify API routes, webhooks, BullMQ jobs, server actions — anything where WorkOS middleware already verified the user
- `rlsDb` (RLS): Edge cases where you want DB-level enforcement as an extra safety net

## Enabling RLS on Tables

Every table must call `.enableRLS()`:

```typescript
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // ... columns
}).enableRLS();
```

Or define policies inline (which implicitly enables RLS):

```typescript
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // ... columns
  },
  (t) => [
    pgPolicy('users_select_own', {
      for: 'select',
      using: sql`id = current_setting('app.current_user_id', true)::uuid`,
    }),
  ]
);
```

## Setting User Context for RLS

When using the RLS client, set the user context in a transaction:

```typescript
import { sql } from 'drizzle-orm';

async function withUserContext<T>(
  userId: string,
  fn: (tx: typeof rlsDb) => Promise<T>
): Promise<T> {
  return rlsDb.transaction(async (tx) => {
    // Set the current user for RLS policies
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    return fn(tx as any);
  });
}

// Usage
const userCases = await withUserContext(authenticatedUserId, async (tx) => {
  return tx.select().from(cases).where(eq(cases.status, 'active'));
  // RLS will automatically filter to only this user's cases
});
```

## Standard RLS Policy Patterns

### Pattern 1: Users Can Only Access Their Own Rows

```typescript
import { sql } from 'drizzle-orm';
import { pgPolicy, pgTable, uuid } from 'drizzle-orm/pg-core';
import { timestamps, softDelete } from './helpers';

export const userPreferences = pgTable(
  'user_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // ... columns
    ...timestamps,
  },
  (t) => [
    pgPolicy('user_prefs_select_own', {
      for: 'select',
      using: sql`user_id = current_setting('app.current_user_id', true)::uuid`,
    }),
    pgPolicy('user_prefs_insert_own', {
      for: 'insert',
      withCheck: sql`user_id = current_setting('app.current_user_id', true)::uuid`,
    }),
    pgPolicy('user_prefs_update_own', {
      for: 'update',
      using: sql`user_id = current_setting('app.current_user_id', true)::uuid`,
      withCheck: sql`user_id = current_setting('app.current_user_id', true)::uuid`,
    }),
    pgPolicy('user_prefs_delete_own', {
      for: 'delete',
      using: sql`user_id = current_setting('app.current_user_id', true)::uuid`,
    }),
  ]
);
```

### Pattern 2: Participants Can Access Shared Resources

For cases, where both client and expert need access:

```typescript
export const cases = pgTable(
  'cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // ... columns
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    pgPolicy('cases_select_participant', {
      for: 'select',
      using: sql`
      id IN (
        SELECT case_id FROM case_participants
        WHERE user_id = current_setting('app.current_user_id', true)::uuid
      )
    `,
    }),
    pgPolicy('cases_update_participant', {
      for: 'update',
      using: sql`
      id IN (
        SELECT case_id FROM case_participants
        WHERE user_id = current_setting('app.current_user_id', true)::uuid
      )
    `,
    }),
  ]
);
```

### Pattern 3: Role-Based Access

```typescript
export const expertProfiles = pgTable(
  'expert_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // ... columns
  },
  (t) => [
    // Anyone can view expert profiles (public marketplace)
    pgPolicy('expert_profiles_select_public', {
      for: 'select',
      using: sql`true`,
    }),
    // Only the expert can update their own profile
    pgPolicy('expert_profiles_update_own', {
      for: 'update',
      using: sql`user_id = current_setting('app.current_user_id', true)::uuid`,
    }),
  ]
);
```

### Pattern 4: Soft Delete Filter in RLS

Include deleted_at filtering in RLS policies:

```typescript
pgPolicy('records_select_active', {
  for: 'select',
  using: sql`
    user_id = current_setting('app.current_user_id', true)::uuid
    AND deleted_at IS NULL
  `,
}),
```

## Service Role / Admin Bypass

The admin `db` client connects as the Postgres superuser and bypasses all RLS. This is the primary client for Balo's Fastify API since WorkOS middleware handles authentication at the application layer.

**Use admin client for:**

- All Fastify route handlers (already authed by WorkOS middleware)
- Webhook handlers (verified by signature)
- BullMQ job processors
- Migration scripts
- Admin operations

**Use RLS client for:**

- Any path where you want defense-in-depth
- Future: if Supabase client is ever exposed to frontend directly

## RLS Checklist for New Tables

- [ ] `.enableRLS()` called or policies defined inline
- [ ] SELECT policy defined
- [ ] INSERT policy with `withCheck` defined
- [ ] UPDATE policy with both `using` and `withCheck` defined
- [ ] DELETE policy defined (or explicitly denied)
- [ ] Soft delete filter included in SELECT policies
- [ ] Indexes exist on columns referenced in policy WHERE clauses
- [ ] Tested with both admin and RLS clients
- [ ] Migration generated with `drizzle-kit generate` (not push)

## Known Issues

- `drizzle-kit push` has bugs with RLS policies — always use `generate` + `migrate`
- `drizzle-kit pull` may not import all policies correctly from Supabase dashboard
- Define policies in code (schema files) as source of truth, not in Supabase dashboard
