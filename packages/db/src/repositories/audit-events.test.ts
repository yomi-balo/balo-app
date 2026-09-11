// `listTrailForEntity` composes its keyset predicate and ORDER BY via `db.select(...)`, so the
// Drizzle `db` client must exist before the repository module loads. The client (`client.ts`)
// initializes EAGERLY at module-evaluation time from `process.env.DATABASE_URL` (postgres-js
// connects lazily, so no Postgres is contacted — these tests only inspect the composed SQL
// ASTs, never execute a query). Static `import` declarations are hoisted ABOVE top-level
// statements, so setting the env var on a top-level line would run too late; the repository
// must therefore be loaded via a dynamic `import()` AFTER the env var is set. Mirrors
// `expert-search.filters.test.ts`.
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/test';

import { describe, it, expect, beforeAll } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { and, desc, eq } from 'drizzle-orm';
import { auditEvents, users } from '../schema';
import type { AuditTrailCursor } from './audit-events';

type AuditEventsModule = typeof import('./audit-events');
type DbModule = typeof import('../client');

let auditTrailKeysetBefore: AuditEventsModule['auditTrailKeysetBefore'];
let db: DbModule['db'];

beforeAll(async () => {
  // Loaded dynamically so `client.ts` evaluates with DATABASE_URL already set.
  const mod = await import('./audit-events');
  auditTrailKeysetBefore = mod.auditTrailKeysetBefore;
  ({ db } = await import('../client'));
});

const DIALECT = new PgDialect();
const toSql = (s: SQL): { sql: string; params: unknown[] } => DIALECT.sqlToQuery(s);

// A realistic, MICROSECOND-precise Postgres `timestamptz::text` value — deliberately NOT a
// whole millisecond, so a regression that truncates it (e.g. round-tripping through a JS
// `Date`) is visible in the pinned params below.
const CURSOR: AuditTrailCursor = {
  createdAtPrecise: '2026-06-02 10:15:30.083951+00',
  seq: 42,
};

describe('auditTrailKeysetBefore', () => {
  it('renders a ROW-VALUE tuple comparison, verbatim (BAL-426 residual 2)', () => {
    const { sql } = toSql(auditTrailKeysetBefore(CURSOR));
    expect(sql).toBe(
      '("audit_events"."created_at", "audit_events"."seq") < ($1::timestamptz, $2::bigint)'
    );
  });

  it('binds the PRECISE Postgres-text string for createdAt VERBATIM (never a Date, never .toISOString()) and the NUMBER for seq', () => {
    const { params } = toSql(auditTrailKeysetBefore(CURSOR));
    // Mutation: wrap cursor.createdAtPrecise in `new Date(...)` / `.toISOString()` in
    // auditTrailKeysetBefore ⇒ this fails immediately (microsecond digits go missing), and
    // against real Postgres a bare Date in a raw sql template also throws AT BIND TIME
    // (memory `reference_date_in_raw_sql_template_throws`) — but `pnpm typecheck` stays green
    // either way, which is why this pin exists.
    expect(params).toEqual(['2026-06-02 10:15:30.083951+00', 42]);
  });

  it('never stringifies seq', () => {
    const { params } = toSql(auditTrailKeysetBefore(CURSOR));
    expect(typeof params[1]).toBe('number');
  });
});

describe('the reader ORDER BY (BAL-426 residual 1)', () => {
  // ⚠⚠ BAL-555 fix round F4 — WHAT THIS SUITE ACTUALLY PINS, CORRECTED. Both queries below are
  // built HERE, inline, with literal `desc(auditEvents.createdAt), desc(auditEvents.seq))` — they
  // do NOT call `listTrailForEntity`. So mutating the PRODUCTION reader's ORDER BY (e.g. to
  // `asc(auditEvents.seq)`) does NOT make either test below fail — it would leave this file's
  // own hardcoded query, and therefore these assertions, completely unaffected. The comments
  // that used to sit on the assertions below ("Mutation: … ⇒ this fails") claimed a mutation
  // proof against `listTrailForEntity` that this file cannot hold, because it never calls it.
  //
  // What these two tests DO genuinely pin: the rendered SQL SHAPE of the exact Drizzle call
  // sequence `listTrailForEntity` uses (`.select().from().leftJoin().where().orderBy().limit()`
  // with `desc(createdAt), desc(seq)`) — a self-contained proof that THIS shape, if written,
  // compiles to the literal ORDER BY text and WHERE-clause absence asserted below. That is a
  // useful fixed point (a future reader copying this shape gets a byte-for-byte precedent to
  // diff against) but it is a SELF-PIN, not a regression guard on `listTrailForEntity` itself.
  //
  // The production reader's OWN ordering is genuinely fenced elsewhere, independently:
  //   · `packages/db/src/invariants/audit-trail-ordering.test.ts` — a source-text scan that reads
  //     `repositories/audit-events.ts` and fails if its `.orderBy(` argument list ever drops
  //     `seq`, tiebreaks on `id`, or mixes `asc`/`desc` directions.
  //   · `packages/db/src/repositories/audit-events.integration.test.ts` — `describe('audit_events
  //     trail ordering (BAL-426)', …)` and the tie tests below it, which call
  //     `listTrailForEntity` against real Postgres and assert the actual row order returned,
  //     including a `// Mutation: asc(seq) ⇒ inverted ⇒ this fails` proof that IS live against
  //     the production function.
  it('renders the exact ORDER BY text this shape produces (a self-pin, not a listTrailForEntity regression guard — see above)', () => {
    // Mirrors the production `.select({...}).from(auditEvents).leftJoin(users, ...)
    // .where(...).orderBy(desc(createdAt), desc(seq)).limit(...)` shape byte-for-byte on the
    // ORDER BY clause, using the SAME `desc()` helper calls the reader does — but as its own,
    // separately-constructed query object.
    const query = db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(and(eq(auditEvents.entityType, 'engagement'), eq(auditEvents.entityId, 'e1')))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.seq))
      .limit(26);

    const { sql } = query.toSQL();
    const marker = ' order by ';
    const markerIndex = sql.toLowerCase().indexOf(marker);
    expect(markerIndex).toBeGreaterThan(-1);
    const tail = sql.slice(markerIndex + marker.length);
    expect(tail).toBe('"audit_events"."created_at" desc, "audit_events"."seq" desc limit $3');
  });

  it('the no-cursor form renders no row-value tuple in its WHERE clause (a self-pin — see the describe-level note above)', () => {
    const query = db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, 'engagement'), eq(auditEvents.entityId, 'e1')))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.seq))
      .limit(26);

    const { sql } = query.toSQL();
    expect(sql).not.toContain('::timestamptz');
    expect(sql).not.toContain('::bigint');
  });
});
