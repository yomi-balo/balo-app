# Relations & Queries — Balo

## Defining Relations

Relations are defined separately from tables in `apps/api/src/db/relations.ts`. They enable the Drizzle Query API for nested/relational fetches.

```typescript
// apps/api/src/db/relations.ts
import { relations } from 'drizzle-orm';
import { users, expertProfiles, cases, caseParticipants, creditWallets } from './schema';

export const usersRelations = relations(users, ({ one, many }) => ({
  expertProfile: one(expertProfiles, {
    fields: [users.id],
    references: [expertProfiles.userId],
  }),
  wallet: one(creditWallets, {
    fields: [users.id],
    references: [creditWallets.userId],
  }),
  participations: many(caseParticipants),
}));

export const expertProfilesRelations = relations(expertProfiles, ({ one }) => ({
  user: one(users, {
    fields: [expertProfiles.userId],
    references: [users.id],
  }),
}));

export const casesRelations = relations(cases, ({ many }) => ({
  participants: many(caseParticipants),
}));

export const caseParticipantsRelations = relations(caseParticipants, ({ one }) => ({
  case: one(cases, {
    fields: [caseParticipants.caseId],
    references: [cases.id],
  }),
  user: one(users, {
    fields: [caseParticipants.userId],
    references: [users.id],
  }),
}));
```

**Rules:**

- Relations do NOT create foreign keys — those are defined in the table schema
- Relations enable the `.query` API for relational data fetching
- Define all relations in one file for clear overview of the data model
- Export relations so they're included when creating the Drizzle client

## Including Relations in DB Client

```typescript
// apps/api/src/db/client.ts
import * as schema from './schema';
import * as relations from './relations';

export const db = drizzle(connection, {
  schema: { ...schema, ...relations },
  casing: 'snake_case',
});
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
