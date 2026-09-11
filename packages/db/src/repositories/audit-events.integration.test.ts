import { describe, it, expect } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../client';
import { auditEvents, users, type AuditEvent } from '../schema';
import {
  agencyFactory,
  agencyMemberFactory,
  companyFactory,
  companyMemberFactory,
  userFactory,
} from '../test/factories';
import { auditEventsRepository, type AuditTrailCursor } from './audit-events';

/**
 * Integration tests for the generic audit writer (BAL-344). Uses the in-harness
 * `db` (per-test transaction, auto-rolled-back). Covers a full-column insert with
 * jsonb round-trip, the nullable-actor path, and participation in a caller tx.
 */

describe('auditEventsRepository.record', () => {
  it('inserts a row with all columns and round-trips the metadata jsonb', async () => {
    const actor = await userFactory();
    const entityId = randomUUID();

    const row = await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'party_domain.captured',
        entityType: 'party_domain',
        entityId,
        metadata: { domain: 'acme.com', nested: { count: 2 }, flag: true },
      },
      db
    );

    expect(row.id).toBeDefined();
    expect(row.actorUserId).toBe(actor.id);
    expect(row.action).toBe('party_domain.captured');
    expect(row.entityType).toBe('party_domain');
    expect(row.entityId).toBe(entityId);
    expect(row.metadata).toEqual({ domain: 'acme.com', nested: { count: 2 }, flag: true });
    expect(row.createdAt).toBeInstanceOf(Date);

    const persisted = await db.select().from(auditEvents).where(eq(auditEvents.id, row.id));
    expect(persisted).toHaveLength(1);
  });

  it('supports a null actor (system/automated event) and defaults metadata to null', async () => {
    const entityId = randomUUID();

    const row = await auditEventsRepository.record(
      {
        actorUserId: null,
        action: 'system.reconciled',
        entityType: 'party_domain',
        entityId,
      },
      db
    );

    expect(row.actorUserId).toBeNull();
    expect(row.metadata).toBeNull();
  });

  it('participates in the caller transaction — the row is absent after a rollback', async () => {
    const actor = await userFactory();
    const entityId = randomUUID();

    await expect(
      db.transaction(async (tx) => {
        await auditEventsRepository.record(
          {
            actorUserId: actor.id,
            action: 'party_domain.captured',
            entityType: 'party_domain',
            entityId,
            metadata: { domain: 'rollback.com' },
          },
          tx
        );
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    const persisted = await db.select().from(auditEvents).where(eq(auditEvents.entityId, entityId));
    expect(persisted).toHaveLength(0);
  });

  /**
   * BAL-535 fix round 2 (F4) — the provenance writer is now used CONCURRENTLY on ONE transaction.
   * `clearReceivablesCoveredByCredit` clears every open receivable on a wallet and records one
   * audit row per row cleared; those inserts are issued together via `Promise.all` on the credit
   * transaction's own `tx` rather than awaited one at a time inside the wallet's advisory lock.
   * That is only safe if `postgres-js` genuinely pipelines several statements on a transaction's
   * reserved connection, so this asserts it against real Postgres instead of trusting the comment
   * that claims it: every row lands, and a later failure still rolls all of them back together.
   */
  it('records several rows CONCURRENTLY on one transaction, and rolls them all back together', async () => {
    const actor = await userFactory();
    const entityIds = [randomUUID(), randomUUID(), randomUUID()];

    const rows = await db.transaction((tx) =>
      Promise.all(
        entityIds.map((entityId) =>
          auditEventsRepository.record(
            {
              actorUserId: actor.id,
              action: 'credit_receivable.cleared_by_credit',
              entityType: 'credit_receivable',
              entityId,
              metadata: { entityId },
            },
            tx
          )
        )
      )
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.entityId).sort()).toEqual([...entityIds].sort());

    const persisted = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'credit_receivable.cleared_by_credit'));
    expect(persisted).toHaveLength(3);

    // Atomicity survives the batching: one rejection aborts the whole set, exactly as the serial
    // `await` loop did.
    const rolledBack = [randomUUID(), randomUUID()];
    await expect(
      db.transaction(async (tx) => {
        await Promise.all(
          rolledBack.map((entityId) =>
            auditEventsRepository.record(
              {
                actorUserId: actor.id,
                action: 'credit_receivable.cleared_on_late_open',
                entityType: 'credit_receivable',
                entityId,
              },
              tx
            )
          )
        );
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    const gone = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'credit_receivable.cleared_on_late_open'));
    expect(gone).toHaveLength(0);
  });
});

describe('auditEventsRepository.countByEntityAndAction', () => {
  it('counts only rows matching entityType + entityId + action (BAL-334 review_cycle)', async () => {
    const actor = await userFactory();
    const engagementId = randomUUID();
    const otherEngagementId = randomUUID();

    // Two completion-request rows for THIS engagement (a withdraw→re-request cycle).
    await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.completion_requested',
        entityType: 'engagement',
        entityId: engagementId,
        metadata: { from: 'active', to: 'pending_acceptance', engagementId },
      },
      db
    );
    await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.completion_requested',
        entityType: 'engagement',
        entityId: engagementId,
        metadata: { from: 'active', to: 'pending_acceptance', engagementId },
      },
      db
    );

    // Negatives that must NOT be counted:
    //  - a different action on the same engagement,
    await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.completion_withdrawn',
        entityType: 'engagement',
        entityId: engagementId,
        metadata: { engagementId },
      },
      db
    );
    //  - the same action on a DIFFERENT engagement,
    await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.completion_requested',
        entityType: 'engagement',
        entityId: otherEngagementId,
        metadata: { engagementId: otherEngagementId },
      },
      db
    );
    //  - the same action + id but a different entityType.
    await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.completion_requested',
        entityType: 'engagement_milestone',
        entityId: engagementId,
        metadata: { engagementId },
      },
      db
    );

    const count = await auditEventsRepository.countByEntityAndAction({
      entityType: 'engagement',
      entityId: engagementId,
      action: 'engagement.completion_requested',
    });
    expect(count).toBe(2);
  });

  it('returns 0 when no matching rows exist', async () => {
    const count = await auditEventsRepository.countByEntityAndAction({
      entityType: 'engagement',
      entityId: randomUUID(),
      action: 'engagement.completion_requested',
    });
    expect(count).toBe(0);
  });
});

describe('auditEventsRepository.countByActorAndActionSince', () => {
  /** Append one `engagement.created` row for `actor`, stamped at `createdAt`. */
  async function seedCreated(actorUserId: string, createdAt: Date): Promise<void> {
    const row = await auditEventsRepository.record(
      {
        actorUserId,
        action: 'engagement.created',
        entityType: 'engagement',
        entityId: randomUUID(),
        metadata: { engagement_type: 'case' },
      },
      db
    );
    await db.update(auditEvents).set({ createdAt }).where(eq(auditEvents.id, row.id));
  }

  it('counts one actor’s rows for one action inside the window (BAL-400 S6)', async () => {
    const actor = await userFactory();
    const other = await userFactory();
    const now = Date.now();
    const since = new Date(now - 3_600_000);

    await seedCreated(actor.id, new Date(now - 60_000));
    await seedCreated(actor.id, new Date(now - 120_000));

    // Negatives that must NOT be counted:
    //  - the same action, same actor, but OUTSIDE the window,
    await seedCreated(actor.id, new Date(now - 7_200_000));
    //  - the same action inside the window, but a DIFFERENT actor,
    await seedCreated(other.id, new Date(now - 60_000));
    //  - a different action by the same actor inside the window.
    await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.accepted',
        entityType: 'engagement',
        entityId: randomUUID(),
      },
      db
    );

    const count = await auditEventsRepository.countByActorAndActionSince({
      actorUserId: actor.id,
      action: 'engagement.created',
      since,
    });
    expect(count).toBe(2);
  });

  it('is inclusive at the boundary instant', async () => {
    const actor = await userFactory();
    const boundary = new Date('2026-01-01T00:00:00.000Z');
    await seedCreated(actor.id, boundary);

    await expect(
      auditEventsRepository.countByActorAndActionSince({
        actorUserId: actor.id,
        action: 'engagement.created',
        since: boundary,
      })
    ).resolves.toBe(1);
    await expect(
      auditEventsRepository.countByActorAndActionSince({
        actorUserId: actor.id,
        action: 'engagement.created',
        since: new Date(boundary.getTime() + 1),
      })
    ).resolves.toBe(0);
  });

  it('returns 0 for an actor with no rows at all', async () => {
    const actor = await userFactory();
    await expect(
      auditEventsRepository.countByActorAndActionSince({
        actorUserId: actor.id,
        action: 'engagement.created',
        since: new Date(0),
      })
    ).resolves.toBe(0);
  });

  it('N2 — engagementType: "case" excludes project kickoffs from the count, even though both emit the SAME action', async () => {
    // `engagement.created` is deliberately type-agnostic (BAL-417): a case create and a
    // project kickoff both write it, distinguished only by `metadata.engagement_type`. The
    // hop-1 booking budget (BAL-400 S6) must count ONLY case creates, or a burst of approved
    // project kickoffs would exhaust a client's case-booking budget with no case involved.
    const actor = await userFactory();
    const now = Date.now();
    const since = new Date(now - 3_600_000);

    await seedCreated(actor.id, new Date(now - 60_000)); // case, in window
    const projectRow = await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.created',
        entityType: 'engagement',
        entityId: randomUUID(),
        metadata: { engagement_type: 'project' },
      },
      db
    );
    await db
      .update(auditEvents)
      .set({ createdAt: new Date(now - 60_000) })
      .where(eq(auditEvents.id, projectRow.id));

    const caseOnlyCount = await auditEventsRepository.countByActorAndActionSince({
      actorUserId: actor.id,
      action: 'engagement.created',
      engagementType: 'case',
      since,
    });
    expect(caseOnlyCount).toBe(1);

    const unfilteredCount = await auditEventsRepository.countByActorAndActionSince({
      actorUserId: actor.id,
      action: 'engagement.created',
      since,
    });
    expect(unfilteredCount).toBe(2);
  });
});

describe('auditEventsRepository.findLatestByEntityAndAction', () => {
  it('returns the most-recent row by created_at for the entity + action', async () => {
    const older = await userFactory();
    const newer = await userFactory();
    const companyId = randomUUID();

    const first = await auditEventsRepository.record(
      {
        actorUserId: older.id,
        action: 'company.join_mode_changed',
        entityType: 'company',
        entityId: companyId,
        metadata: { from: 'auto', to: 'request' },
      },
      db
    );
    const second = await auditEventsRepository.record(
      {
        actorUserId: newer.id,
        action: 'company.join_mode_changed',
        entityType: 'company',
        entityId: companyId,
        metadata: { from: 'request', to: 'off' },
      },
      db
    );
    // Force a deterministic ordering (first older than second).
    await db
      .update(auditEvents)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(auditEvents.id, first.id));
    await db
      .update(auditEvents)
      .set({ createdAt: new Date('2021-01-01T00:00:00Z') })
      .where(eq(auditEvents.id, second.id));

    // A different action on the same entity must NOT win.
    await auditEventsRepository.record(
      {
        actorUserId: older.id,
        action: 'company.renamed',
        entityType: 'company',
        entityId: companyId,
      },
      db
    );

    const latest = await auditEventsRepository.findLatestByEntityAndAction({
      entityType: 'company',
      entityId: companyId,
      action: 'company.join_mode_changed',
    });

    expect(latest?.actorUserId).toBe(newer.id);
    expect(latest?.createdAt).toBeInstanceOf(Date);
  });

  it('returns undefined when the action has never occurred for the entity', async () => {
    await expect(
      auditEventsRepository.findLatestByEntityAndAction({
        entityType: 'company',
        entityId: randomUUID(),
        action: 'company.join_mode_changed',
      })
    ).resolves.toBeUndefined();
  });
});

/**
 * BAL-426 AC #3. ≥20 iterations, and the number is NOT ceremony — with `seq` in the ORDER BY
 * these assertions are DETERMINISTIC, so 20 passing runs prove nothing on their own. The count
 * exists for the MUTATION PROOF: flip `asc(auditEvents.seq)` back to `asc(auditEvents.id)` in
 * `trailFor` below and ONE iteration still passes ~50 % of the time (two random v4 uuids), while
 * 20 independent iterations fail with probability 1 − 2⁻²⁰ ≈ 0.999999. That is what turns a
 * coin-flip mutation test into a reliable one. Shrink this number and the mutation test stops
 * biting. It HAS been run that way — see the PR body.
 *
 * ⚠ SERIAL `await`s, NEVER `Promise.all`. The concurrency test above deliberately batches its
 * inserts with `Promise.all`; that has NO defined source order on the `max: 1` pool, so an
 * ordering assertion written in that shape would be vacuous.
 */
const ORDERING_TRIALS = 20;

/**
 * Local reader that states the contract LITERALLY, deliberately not shared with the other
 * suites: the mutation proof needs exactly one line to flip.
 */
async function trailFor(entityId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.seq));
}

describe('audit_events trail ordering (BAL-426)', () => {
  it(`reads two same-transaction rows back in INSERTION order (${ORDERING_TRIALS} trials)`, async () => {
    const seqs: number[] = [];

    for (let trial = 0; trial < ORDERING_TRIALS; trial += 1) {
      const entityId = randomUUID();

      // One transaction, two SERIAL awaits — the exact shape ADR-1030 prescribes and the exact
      // shape `materializeFromKickoff` / `close()` / `share()` use in production.
      await db.transaction(async (tx) => {
        await auditEventsRepository.record(
          {
            actorUserId: null,
            action: 'ordering_probe.first',
            entityType: 'ordering_probe',
            entityId,
            metadata: { trial },
          },
          tx
        );
        await auditEventsRepository.record(
          {
            actorUserId: null,
            action: 'ordering_probe.second',
            entityType: 'ordering_probe',
            entityId,
            metadata: { trial },
          },
          tx
        );
      });

      const rows = await trailFor(entityId);
      expect(rows).toHaveLength(2);
      const [first, second] = rows;
      if (first === undefined || second === undefined) throw new Error('expected two audit rows');

      // ⚠ THE PREMISE, PINNED. If `created_at` ever stopped tying — someone switching the default
      // to clock_timestamp(), say — this test would start passing for the WRONG reason (ordered by
      // the timestamp, never consulting `seq`) and the mutation proof would silently stop biting.
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());

      expect([first.action, second.action]).toEqual([
        'ordering_probe.first',
        'ordering_probe.second',
      ]);
      expect(first.seq).toBeLessThan(second.seq);
      seqs.push(first.seq, second.seq);
    }

    // Allocation is monotonic across the whole run, not merely within a pair. GAPS ARE EXPECTED
    // AND CORRECT (sequences are non-transactional) — this asserts increase, never contiguity.
    let previous = Number.NEGATIVE_INFINITY;
    for (const value of seqs) {
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  /**
   * Closes the gap the AC #2 production fix would otherwise ship into. The existing
   * `findLatestByEntityAndAction` suite fabricates DISTINCT `created_at` values with an `UPDATE`,
   * so it passes with or without `desc(seq)` — it has NO coverage of the same-transaction tie the
   * fix actually repairs. This does, and both rows share entity + action so the tie is the real
   * one: before `desc(seq)` this function had no tiebreaker whatsoever.
   */
  it(`findLatestByEntityAndAction resolves a same-transaction tie to the LAST row (${ORDERING_TRIALS} trials)`, async () => {
    for (let trial = 0; trial < ORDERING_TRIALS; trial += 1) {
      const entityId = randomUUID();

      await db.transaction(async (tx) => {
        await auditEventsRepository.record(
          {
            actorUserId: null,
            action: 'company.join_mode_changed',
            entityType: 'ordering_probe',
            entityId,
            metadata: { position: 'first' },
          },
          tx
        );
        await auditEventsRepository.record(
          {
            actorUserId: null,
            action: 'company.join_mode_changed',
            entityType: 'ordering_probe',
            entityId,
            metadata: { position: 'second' },
          },
          tx
        );
      });

      // Same premise pin as the test above: both rows really do tie on `created_at`, so this
      // exercises `seq` and not the timestamp.
      const rows = await trailFor(entityId);
      expect(rows).toHaveLength(2);
      const [first, second] = rows;
      if (first === undefined || second === undefined) throw new Error('expected two audit rows');
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());

      const latest = await auditEventsRepository.findLatestByEntityAndAction({
        entityType: 'ordering_probe',
        entityId,
        action: 'company.join_mode_changed',
      });
      expect(latest?.metadata).toEqual({ position: 'second' });
    }
  });
});

/**
 * BAL-555 — `listTrailForEntity`, the Lookup Timeline reader. Extends the file's own
 * `ORDERING_TRIALS` pattern and `trailFor` local oracle (both defined above) as the
 * cross-check for the keyset cursor.
 */
describe('auditEventsRepository.listTrailForEntity', () => {
  async function record(input: {
    entityId: string;
    actorUserId: string | null;
    action?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditEvent> {
    return auditEventsRepository.record(
      {
        actorUserId: input.actorUserId,
        action: input.action ?? 'ordering_probe.first',
        entityType: 'ordering_probe',
        entityId: input.entityId,
        metadata: input.metadata,
      },
      db
    );
  }

  it(`reads a same-transaction tie back ASCENDING (${ORDERING_TRIALS} trials)`, async () => {
    for (let trial = 0; trial < ORDERING_TRIALS; trial += 1) {
      const entityId = randomUUID();

      await db.transaction(async (tx) => {
        await auditEventsRepository.record(
          {
            actorUserId: null,
            action: 'ordering_probe.first',
            entityType: 'ordering_probe',
            entityId,
          },
          tx
        );
        await auditEventsRepository.record(
          {
            actorUserId: null,
            action: 'ordering_probe.second',
            entityType: 'ordering_probe',
            entityId,
          },
          tx
        );
      });

      const oracle = await trailFor(entityId);
      expect(oracle).toHaveLength(2);
      const [first, second] = oracle;
      if (first === undefined || second === undefined) throw new Error('expected two audit rows');
      // Premise pin, mirroring the suite above.
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());

      const page = await auditEventsRepository.listTrailForEntity({
        entityType: 'ordering_probe',
        entityId,
        limit: 25,
        authorizedPlatformStaff: true,
      });
      // Mutation: `asc(seq)` in the reader ⇒ inverted ⇒ this fails.
      expect(page.rows.map((r) => r.action)).toEqual([
        'ordering_probe.first',
        'ordering_probe.second',
      ]);
    }
  });

  it('the cursor round-trip across a tie that spans a page boundary matches the oracle exactly — NATURAL microsecond precision, no forced timestamps', async () => {
    // ⚠ BAL-555 fix round — this test used to force clean, WHOLE-MILLISECOND, explicitly
    // distinct `created_at` values via `db.update(...)` for two separate tie groups, precisely
    // to SIDESTEP the precision this defect lives in. That was a workaround for the bug, not a
    // test of the fix — it could never have caught the truncation defect it was named after.
    //
    // Here every row is seeded with NO `db.update(...)` at all: `record()` is called directly
    // on `db`, which in this harness (`setup-integration.ts`) IS the one per-test transaction
    // (nested `db.transaction()` calls inside a repository become SAVEPOINTs on it, never a
    // second top-level transaction) — so every row's `created_at` is the SAME
    // `transaction_timestamp()`, at its genuine, naturally-occurring MICROSECOND precision,
    // whatever that happens to be. That is exactly the shape the defect needs: a real tie group
    // larger than one page, at real sub-millisecond precision. Against the truncating
    // (`Date`/`.toISOString()`) form of the cursor, the very FIRST cursor built from this tie
    // group is already LESS than every row's true `created_at` (the truncated value is always
    // ⩽ the real one), so the row-value predicate excludes the entire remaining group — every
    // page after the first comes back empty and `collected` ends up short. See the PR body for
    // the before/after proof this test was run against.
    const entityId = randomUUID();
    const TIE_GROUP_SIZE = 5; // > the limit:2 page size below, so paging must cross a boundary
    // INSIDE this one natural tie.

    for (let i = 0; i < TIE_GROUP_SIZE; i += 1) {
      await record({ entityId, actorUserId: null, action: `ordering_probe.tie_${i}` });
    }

    const oracle = await trailFor(entityId);
    expect(oracle).toHaveLength(TIE_GROUP_SIZE);
    // The premise, pinned: every row in this group genuinely ties on created_at — if it didn't,
    // this test would pass for the wrong reason (ordered by the timestamp, never needing the
    // cursor's precision at all).
    const [firstOracleRow] = oracle;
    if (firstOracleRow === undefined) throw new Error('expected at least one row');
    for (const row of oracle) {
      expect(row.createdAt.getTime()).toBe(firstOracleRow.createdAt.getTime());
    }

    // ⚠⚠ BAL-555 fix round F8 — THE SECOND HALF OF THE PREMISE, PINNED. Tying on `.getTime()`
    // (millisecond precision) is not enough: it is satisfied just as well by a tie that ALSO
    // happens to land on a whole millisecond (`transaction_timestamp()` doing so is rare but
    // real — roughly 1 run in 1000). In that specific case a TRUNCATING (Date-round-tripped)
    // cursor pages this exact tie group correctly too, by accident, and this test would report
    // a false green for the precision-loss bug it exists to catch. Read the SAME row's
    // `created_at::text` independently of `trailFor` (which selects a plain, already-truncated
    // `Date` column) and assert it genuinely carries a fractional-second component longer than
    // 3 digits — i.e. real sub-millisecond precision, not merely a value under 1000ms.
    const [rawFirst] = await db
      .select({ createdAtText: sql<string>`${auditEvents.createdAt}::text` })
      .from(auditEvents)
      .where(eq(auditEvents.id, firstOracleRow.id));
    if (rawFirst === undefined) throw new Error('expected the seeded row to still exist');
    const fractionalDigits = /\.(\d+)[+-]\d/.exec(rawFirst.createdAtText)?.[1] ?? '';
    expect(
      fractionalDigits.length,
      `Seeded created_at was "${rawFirst.createdAtText}" — expected more than 3 fractional-second ` +
        'digits (genuine sub-millisecond precision). This run landed on a whole millisecond ' +
        '(the ~1-in-1000 case), so this specific tie group cannot exercise the truncation bug ' +
        'this test is named after. Re-run the suite.'
    ).toBeGreaterThan(3);

    // Page with limit: 2 until hasEarlier is false, concatenating OLDEST-FIRST pages in the
    // order they are returned (each page is itself ascending, and earlier pages are older).
    const collected: string[] = [];
    let before: AuditTrailCursor | undefined;
    let hasEarlier = true;
    let guard = 0;
    const olderPages: string[][] = [];
    while (hasEarlier) {
      guard += 1;
      if (guard > 10) throw new Error('pagination did not terminate');
      const page = await auditEventsRepository.listTrailForEntity({
        entityType: 'ordering_probe',
        entityId,
        limit: 2,
        before,
        authorizedPlatformStaff: true,
      });
      olderPages.unshift(page.rows.map((r) => r.id));
      hasEarlier = page.hasEarlier;
      before = page.earlierCursor ?? undefined;
    }
    for (const page of olderPages) collected.push(...page);

    // Mutation: swap auditTrailKeysetBefore for and(lt(createdAt), lt(seq)) ⇒ rows drop.
    // Mutation: round-trip cursor.createdAtPrecise through `new Date(...)` / `.toISOString()`
    // ⇒ this whole tie group is dropped after the first page (see the comment above).
    expect(collected).toEqual(oracle.map((row) => row.id));
    expect(new Set(collected).size).toBe(oracle.length); // no duplicate id
  });

  it('scopes strictly to entityType + entityId', async () => {
    const entityId = randomUUID();
    const otherEntityId = randomUUID();

    await record({ entityId, actorUserId: null, action: 'ordering_probe.in_scope' });
    await record({
      entityId: otherEntityId,
      actorUserId: null,
      action: 'ordering_probe.other_entity',
    });
    // Same entityId, different entityType.
    await auditEventsRepository.record(
      {
        actorUserId: null,
        action: 'ordering_probe.other_type',
        entityType: 'ordering_probe_other',
        entityId,
      },
      db
    );

    const page = await auditEventsRepository.listTrailForEntity({
      entityType: 'ordering_probe',
      entityId,
      limit: 25,
      authorizedPlatformStaff: true,
    });
    expect(page.rows.map((r) => r.action)).toEqual(['ordering_probe.in_scope']);
  });

  it('hydrates actor name + platformRole, and a soft-deleted actor still attributes', async () => {
    const entityId = randomUUID();
    const actor = await userFactory({
      firstName: 'Dana',
      lastName: 'Whitfield',
      platformRole: 'user',
    });
    await record({ entityId, actorUserId: actor.id });

    const deletedActor = await userFactory({ firstName: 'Ghost', lastName: 'Actor' });
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, deletedActor.id));
    await record({ entityId, actorUserId: deletedActor.id, action: 'ordering_probe.second' });

    await record({ entityId, actorUserId: null, action: 'ordering_probe.system' });

    const page = await auditEventsRepository.listTrailForEntity({
      entityType: 'ordering_probe',
      entityId,
      limit: 25,
      authorizedPlatformStaff: true,
    });

    const live = page.rows.find((r) => r.actorUserId === actor.id);
    expect(live?.actorFirstName).toBe('Dana');
    expect(live?.actorLastName).toBe('Whitfield');
    expect(live?.actorPlatformRole).toBe('user');

    // ⚠ NO isNull(users.deletedAt) guard, deliberately — a soft-deleted actor still attributes.
    const deleted = page.rows.find((r) => r.actorUserId === deletedActor.id);
    expect(deleted?.actorFirstName).toBe('Ghost');
    expect(deleted?.actorLastName).toBe('Actor');

    const systemRow = page.rows.find((r) => r.actorUserId === null);
    expect(systemRow?.actorFirstName).toBeNull();
    expect(systemRow?.actorLastName).toBeNull();
    expect(systemRow?.actorPlatformRole).toBeNull();
    expect(systemRow?.actorCompanyName).toBeNull();
    expect(systemRow?.actorAgencyName).toBeNull();
  });

  it('resolves the oldest LIVE company/agency membership name, and nulls when there is none', async () => {
    const entityId = randomUUID();

    const companyActor = await userFactory();
    const company1 = await companyFactory({ name: 'Older Co' });
    const company2 = await companyFactory({ name: 'Newer Co' });
    await companyMemberFactory({
      companyId: company1.id,
      userId: companyActor.id,
      joinedAt: new Date('2020-01-01T00:00:00Z'),
    });
    await companyMemberFactory({
      companyId: company2.id,
      userId: companyActor.id,
      joinedAt: new Date('2021-01-01T00:00:00Z'),
    });
    await record({ entityId, actorUserId: companyActor.id, action: 'ordering_probe.company' });

    const agencyActor = await userFactory();
    const agency = await agencyFactory({ name: 'CloudPeak' });
    await agencyMemberFactory({ agencyId: agency.id, userId: agencyActor.id });
    await record({ entityId, actorUserId: agencyActor.id, action: 'ordering_probe.agency' });

    const noMembershipActor = await userFactory();
    await record({ entityId, actorUserId: noMembershipActor.id, action: 'ordering_probe.none' });

    const page = await auditEventsRepository.listTrailForEntity({
      entityType: 'ordering_probe',
      entityId,
      limit: 25,
      authorizedPlatformStaff: true,
    });

    const companyRow = page.rows.find((r) => r.actorUserId === companyActor.id);
    expect(companyRow?.actorCompanyName).toBe('Older Co'); // oldest live membership wins
    expect(companyRow?.actorAgencyName).toBeNull();

    const agencyRow = page.rows.find((r) => r.actorUserId === agencyActor.id);
    expect(agencyRow?.actorAgencyName).toBe('CloudPeak');
    expect(agencyRow?.actorCompanyName).toBeNull();

    const noneRow = page.rows.find((r) => r.actorUserId === noMembershipActor.id);
    expect(noneRow?.actorCompanyName).toBeNull();
    expect(noneRow?.actorAgencyName).toBeNull();
  });

  it('an empty page issues the batched org lookup with no ids, and returns hasEarlier: false / earlierCursor: null', async () => {
    const page = await auditEventsRepository.listTrailForEntity({
      entityType: 'ordering_probe',
      entityId: randomUUID(),
      limit: 25,
      authorizedPlatformStaff: true,
    });
    expect(page.rows).toEqual([]);
    expect(page.hasEarlier).toBe(false);
    expect(page.earlierCursor).toBeNull();
  });

  it('hasEarlier is false and earlierCursor is null on a complete first page', async () => {
    const entityId = randomUUID();
    await record({ entityId, actorUserId: null });
    await record({ entityId, actorUserId: null, action: 'ordering_probe.second' });

    const page = await auditEventsRepository.listTrailForEntity({
      entityType: 'ordering_probe',
      entityId,
      limit: 25,
      authorizedPlatformStaff: true,
    });
    expect(page.hasEarlier).toBe(false);
    expect(page.earlierCursor).toBeNull();
  });

  it("earlierCursor carries the oldest row's FULL-PRECISION created_at, not the millisecond-truncated Date", async () => {
    const entityId = randomUUID();
    await record({ entityId, actorUserId: null, action: 'ordering_probe.first' });
    await record({ entityId, actorUserId: null, action: 'ordering_probe.second' });
    await record({ entityId, actorUserId: null, action: 'ordering_probe.third' });

    const page = await auditEventsRepository.listTrailForEntity({
      entityType: 'ordering_probe',
      entityId,
      limit: 2,
      authorizedPlatformStaff: true,
    });
    expect(page.hasEarlier).toBe(true);
    const [oldest] = page.rows;
    if (oldest === undefined) throw new Error('expected at least one row');

    // Independently read the SAME row's `created_at::text` — the oracle for full precision,
    // deliberately NOT `oldest.createdAt.toISOString()` (that IS the millisecond-truncated
    // value this test must not be fooled by).
    const [raw] = await db
      .select({ createdAtText: sql<string>`${auditEvents.createdAt}::text` })
      .from(auditEvents)
      .where(eq(auditEvents.id, oldest.id));
    if (raw === undefined) throw new Error('expected the oldest row to still exist');

    expect(page.earlierCursor).toEqual({ createdAtPrecise: raw.createdAtText, seq: oldest.seq });
  });

  it('the precise-string bind proof — the cursor path executes at all against real Postgres', async () => {
    // ⚠ This is the ONLY gate that catches `reference_date_in_raw_sql_template_throws` — a
    // bare Date in a raw sql template throws "Received an instance of Date" AT BIND TIME. It
    // also proves `cursor.createdAtPrecise` (a plain string, `created_at::text`) binds cleanly
    // as `$1::timestamptz` (BAL-555). `pnpm typecheck` stays green either way.
    const entityId = randomUUID();
    await record({ entityId, actorUserId: null, action: 'ordering_probe.first' });
    await record({ entityId, actorUserId: null, action: 'ordering_probe.second' });
    const firstPage = await auditEventsRepository.listTrailForEntity({
      entityType: 'ordering_probe',
      entityId,
      limit: 1,
      authorizedPlatformStaff: true,
    });
    const cursor = firstPage.earlierCursor;
    expect(cursor).not.toBeNull();
    if (cursor === null) throw new Error('expected a cursor');
    await expect(
      auditEventsRepository.listTrailForEntity({
        entityType: 'ordering_probe',
        entityId,
        limit: 1,
        before: cursor,
        authorizedPlatformStaff: true,
      })
    ).resolves.toBeDefined();
  });
});
