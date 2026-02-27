# Relations & Queries — Balo

## Defining Relations

Relations are defined **in the same file as their table**, immediately after the table definition. This keeps related code together and is the established pattern in the codebase.

```typescript
// packages/db/src/schema/users.ts
import { pgTable, uuid, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { userModeEnum, userStatusEnum } from './enums';
import { companyMembers } from './companies';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  workosId: text('workos_id').unique().notNull(),
  email: text('email').unique().notNull(),
  // ...
});

// Relations defined HERE, in the same file
export const usersRelations = relations(users, ({ many }) => ({
  companyMemberships: many(companyMembers),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

**Rules:**

- Relations do NOT create foreign keys — those are defined in the table schema
- Relations enable the `.query` API for relational data fetching
- Define relations in the SAME file as the primary table
- Export relations so they're included via the barrel export in `schema/index.ts`

## Including Relations in DB Client

All schemas (including co-located relations) are imported via the barrel export:

```typescript
// packages/db/src/client.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;
const client = postgres(connectionString);

export const db = drizzle(client, { schema });
```

## Query API (Relational Queries)

### Fetch with Relations

```typescript
// Get user with their expert profile and wallet
const user = await db.query.users.findFirst({
  where: eq(users.id, userId),
  with: {
    expertProfile: true,
    wallet: true,
  },
});

// Get case with participants and their user info
const caseData = await db.query.cases.findFirst({
  where: eq(cases.id, caseId),
  with: {
    participants: {
      with: {
        user: {
          columns: { id: true, firstName: true, lastName: true, avatarUrl: true },
        },
      },
    },
  },
});
```

### Selective Columns

Avoid overfetching:

```typescript
const experts = await db.query.expertProfiles.findMany({
  columns: {
    id: true,
    title: true,
    hourlyRateCents: true,
  },
  with: {
    user: {
      columns: { firstName: true, lastName: true, avatarUrl: true },
    },
  },
  limit: 20,
});
```

### Filtering in Relations

```typescript
const userWithActiveCases = await db.query.users.findFirst({
  where: eq(users.id, userId),
  with: {
    participations: {
      where: eq(caseParticipants.role, 'active'),
      with: {
        case: {
          columns: { id: true, title: true, status: true },
        },
      },
    },
  },
});
```

## Standard Select Queries

### Basic Select

```typescript
import { eq, and, isNull } from 'drizzle-orm';

// Active users (not soft deleted)
const activeUsers = await db
  .select()
  .from(users)
  .where(and(eq(users.role, 'expert'), isNull(users.deletedAt)));
```

**Rule:** Always filter `isNull(table.deletedAt)` in queries unless you specifically need soft-deleted rows (e.g., audit, admin views). Repository methods should include this by default.

### Select with Join

```typescript
const casesWithParticipants = await db
  .select({
    case: cases,
    participant: caseParticipants,
    user: {
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
    },
  })
  .from(cases)
  .innerJoin(caseParticipants, eq(cases.id, caseParticipants.caseId))
  .innerJoin(users, eq(caseParticipants.userId, users.id))
  .where(eq(cases.status, 'active'));
```

### Pagination

```typescript
const page = 1;
const pageSize = 20;

const results = await db
  .select()
  .from(expertProfiles)
  .where(isNull(expertProfiles.deletedAt))
  .orderBy(desc(expertProfiles.createdAt))
  .limit(pageSize)
  .offset((page - 1) * pageSize);
```

## Insert Patterns

### Single Insert

```typescript
const [newUser] = await db
  .insert(users)
  .values({
    email: 'user@example.com',
    workosUserId: 'user_abc123',
    role: 'client',
  })
  .returning();
```

### Bulk Insert

```typescript
const newParticipants = await db
  .insert(caseParticipants)
  .values([
    { caseId, userId: clientId, role: 'client' },
    { caseId, userId: expertId, role: 'expert' },
  ])
  .returning();
```

### Upsert (Insert or Update)

```typescript
await db
  .insert(userPreferences)
  .values({ userId, theme: 'dark', language: 'en' })
  .onConflictDoUpdate({
    target: userPreferences.userId,
    set: { theme: 'dark', updatedAt: new Date() },
  });
```

## Update Patterns

```typescript
const [updated] = await db
  .update(expertProfiles)
  .set({
    title: 'Senior Salesforce Consultant',
    updatedAt: new Date(),
  })
  .where(eq(expertProfiles.userId, userId))
  .returning();
```

### Soft Delete

```typescript
await db.update(cases).set({ deletedAt: new Date() }).where(eq(cases.id, caseId));
```

## Transaction Patterns

### Atomic Operations

```typescript
const result = await db.transaction(async (tx) => {
  // Create case
  const [newCase] = await tx.insert(cases).values({ title, status: 'pending' }).returning();

  // Add participants
  await tx.insert(caseParticipants).values([
    { caseId: newCase.id, userId: clientId, role: 'client' },
    { caseId: newCase.id, userId: expertId, role: 'expert' },
  ]);

  // Debit client wallet
  await tx
    .update(creditWallets)
    .set({
      balanceCents: sql`balance_cents - ${depositAmountCents}`,
    })
    .where(and(eq(creditWallets.userId, clientId), sql`balance_cents >= ${depositAmountCents}`));

  return newCase;
});
```

**Rule:** Use transactions when multiple operations must succeed or fail together. Especially for wallet/credit operations.

## Avoiding N+1 Queries

### Bad: N+1 Pattern

```typescript
// ❌ Fetches participants in a loop
const cases = await db.select().from(cases);
for (const c of cases) {
  const participants = await db
    .select()
    .from(caseParticipants)
    .where(eq(caseParticipants.caseId, c.id));
}
```

### Good: Use Relations or Joins

```typescript
// ✅ Single query with relations
const cases = await db.query.cases.findMany({
  with: { participants: { with: { user: true } } },
});

// ✅ Or use a join
const results = await db
  .select()
  .from(cases)
  .leftJoin(caseParticipants, eq(cases.id, caseParticipants.caseId));
```

## Prepared Statements

For queries that run frequently (auth checks, user lookups):

```typescript
const getUserByWorkosId = db
  .select()
  .from(users)
  .where(eq(users.workosUserId, sql.placeholder('workosId')))
  .prepare('get_user_by_workos_id');

// Reuse — prepared statements are faster
const user = await getUserByWorkosId.execute({ workosId: 'user_abc123' });
```
