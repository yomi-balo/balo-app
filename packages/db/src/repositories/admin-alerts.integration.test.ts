import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { AdminAlertDetail } from '@balo/shared/admin-alerts';
import { db } from '../client';
import { adminAlerts, adminSweepTicks, auditEvents } from '../schema';
import type { AdminAlert } from '../schema';
import { userFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import {
  adminAlertsRepository,
  adminSweepTicksRepository,
  type AdminAlertFinding,
} from './admin-alerts';

/**
 * BAL-548 / ADR-1055 — `admin_alerts`, the pending-actions queue.
 *
 * Four things this suite exists to hold, beyond the usual happy paths:
 *
 *  1. **The `ON CONFLICT` arbiter really resolves.** `admin_alerts_open_uidx` is PARTIAL, and
 *     Postgres only accepts a partial index as an arbiter when the statement restates its
 *     predicate in a form it can prove implies the index. A wrong restatement fails with
 *     **42P10 at RUNTIME ONLY** — `tsc` is green, and a mocked unit test is green because a
 *     mocked Drizzle client never reaches a planner. The `raise() twice` case below is the
 *     ONLY thing standing between that and production. ⚠ A test that raised two DIFFERENT
 *     entities would pass while proving nothing: it must hit the CONFLICT path.
 *  2. **`admin_alerts_manual_close_carries_a_note` is satisfied by BOTH close paths.** The
 *     sweep closes with `resolved_by_user_id = NULL` and must therefore ALSO leave the note
 *     NULL; a person closes with both. A violation is a runtime 23514, invisible to `tsc`, so
 *     the sweep's auto-close is exercised for real rather than argued.
 *  3. **`occurrences` moves on `raise` and NEVER on a sweep tick.** Otherwise "raised 3×"
 *     silently becomes "the sweep has run 4,000 times".
 *  4. **Resolving frees the (kind, entity) slot.** Recurrence is a NEW row; a resolved row is
 *     never reopened.
 *
 * ⚠ `kind` IS UNCONSTRAINED `text` AT THE DATABASE LEVEL — validated at the write site against
 * `@balo/shared/admin-alerts`, never by Postgres. This suite therefore uses its own kind
 * strings: it is testing the TABLE and the repository, not the registry's vocabulary, and
 * pinning real kind names here would make the suite fail every time a kind is renamed.
 *
 * ⚠ `entity_id` HAS NO FOREIGN KEY (the column is polymorphic across six tables), so a bare
 * `randomUUID()` is a legitimate entity for these purposes.
 *
 * ⚠ CONCURRENCY IS NOT EXPRESSIBLE HERE. The harness runs ONE transaction per test on a
 * `max:1` pool, so `close()`'s `FOR UPDATE` serialisation is argued by inspection; a green run
 * is not evidence of it.
 */

const SENTINEL_ENTITY_ID = '00000000-0000-4000-8000-000000005548';

function detail(overrides: Partial<AdminAlertDetail> = {}): AdminAlertDetail {
  return {
    title: 'Something needs a person',
    entityLabel: 'Dana @ Northwind Industrial',
    evidence: 'It has been waiting 6 days.',
    facts: [['Waiting', '6 days']],
    ...overrides,
  };
}

function finding(entityId: string, evidence: string): AdminAlertFinding {
  return { entityType: 'company', entityId, detail: detail({ evidence }) };
}

/** A tick's reconcile arguments, with only `kind`/`found`/`now` varying between calls. */
function tick(input: {
  kind: string;
  found: readonly AdminAlertFinding[];
  now: Date;
  stormThreshold?: number;
  batchFilled?: boolean;
}) {
  return {
    kind: input.kind,
    found: input.found,
    stormThreshold: input.stormThreshold ?? 25,
    stormSampleLimit: 3,
    stormKind: `${input.kind}.storm`,
    sentinelEntityId: SENTINEL_ENTITY_ID,
    now: input.now,
    batchFilled: input.batchFilled ?? false,
  };
}

/** Re-reads raw rows for a kind, INCLUDING resolved and soft-deleted ones. */
async function rawRows(kinds: string[]): Promise<AdminAlert[]> {
  return db.select().from(adminAlerts).where(inArray(adminAlerts.kind, kinds));
}

async function rawRow(alertId: string): Promise<AdminAlert | undefined> {
  const [row] = await db.select().from(adminAlerts).where(eq(adminAlerts.id, alertId));
  return row;
}

/** One fresh OPEN row of `kind`, on its own entity. */
async function raiseOn(kind: string): Promise<AdminAlert> {
  return adminAlertsRepository.raise({
    kind,
    entityType: 'company',
    entityId: randomUUID(),
    detail: detail(),
  });
}

/**
 * Resolve / soft-delete a row DIRECTLY, bypassing the repository.
 *
 * ⚠ DELIBERATE: these set up the states the READS must exclude, and `close()` refuses a finder
 * kind while nothing writes `deleted_at` at all in v1 — so the repository cannot produce
 * either state. Note that a bare `resolved_at` with no resolver and no note is exactly the
 * SWEEP's close shape, so this also stays inside `admin_alerts_manual_close_carries_a_note`.
 */
async function markResolvedRaw(alertId: string): Promise<void> {
  await db.update(adminAlerts).set({ resolvedAt: new Date() }).where(eq(adminAlerts.id, alertId));
}

async function markDeletedRaw(alertId: string): Promise<void> {
  await db.update(adminAlerts).set({ deletedAt: new Date() }).where(eq(adminAlerts.id, alertId));
}

describe('adminAlertsRepository.raise', () => {
  it('inserts a fresh open row with occurrences 1 and first_seen_at === last_seen_at', async () => {
    const kind = `test.fresh.${randomUUID()}`;
    const entityId = randomUUID();

    const row = await adminAlertsRepository.raise({
      kind,
      entityType: 'company',
      entityId,
      detail: detail(),
    });

    expect(row.occurrences).toBe(1);
    expect(row.resolvedAt).toBeNull();
    expect(row.resolvedByUserId).toBeNull();
    expect(row.resolutionNote).toBeNull();
    expect(row.deletedAt).toBeNull();
    // Both columns default to `now()` on the insert, so they are byte-identical here.
    expect(row.lastSeenAt.getTime()).toBe(row.firstSeenAt.getTime());
    expect(row.detail.evidence).toBe('It has been waiting 6 days.');
  });

  /**
   * ⚠⚠ THE 42P10 TEST. Both raises name the SAME (kind, entity_id), so the second one MUST
   * take the `ON CONFLICT` arm — which is the only way `admin_alerts_open_uidx` is ever asked
   * to act as an arbiter. If `raise`'s `targetWhere` is dropped, reworded, or replaced by a
   * parameterised predicate, this test fails with 42P10 and NOTHING ELSE IN THE REPO WILL.
   */
  it('raise() twice on the SAME (kind, entity) keeps ONE row: occurrences 2, last_seen_at advanced, detail REPLACED', async () => {
    const kind = `test.conflict.${randomUUID()}`;
    const entityId = randomUUID();

    const first = await adminAlertsRepository.raise({
      kind,
      entityType: 'company',
      entityId,
      detail: detail({ evidence: 'first sighting' }),
    });

    // Force a KNOWN, older `last_seen_at` so "advanced" is a real assertion rather than a
    // race against the clock: `now()` inside the harness is transaction START time, so two
    // rows written "seconds apart" here can share a byte-identical default.
    const backdated = new Date('2026-01-01T00:00:00.000Z');
    await db.update(adminAlerts).set({ lastSeenAt: backdated }).where(eq(adminAlerts.id, first.id));

    const second = await adminAlertsRepository.raise({
      kind,
      entityType: 'company',
      entityId,
      detail: detail({ evidence: 'second sighting' }),
    });

    expect(second.id).toBe(first.id);
    expect(second.occurrences).toBe(2);
    expect(second.lastSeenAt.getTime()).toBeGreaterThan(backdated.getTime());
    // REPLACED, not merged — the newest evidence wins.
    expect(second.detail.evidence).toBe('second sighting');
    // …and `first_seen_at` did NOT move: the row keeps its age, which is what the queue sorts on.
    expect(second.firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());

    expect(await rawRows([kind])).toHaveLength(1);
  });

  it('raise() after the row was RESOLVED inserts a NEW row (the partial unique freed the slot)', async () => {
    const kind = `test.recurrence.${randomUUID()}`;
    const entityId = randomUUID();

    const first = await adminAlertsRepository.raise({
      kind,
      entityType: 'company',
      entityId,
      detail: detail(),
    });
    await db
      .update(adminAlerts)
      .set({ resolvedAt: new Date('2026-02-01T00:00:00.000Z') })
      .where(eq(adminAlerts.id, first.id));

    const second = await adminAlertsRepository.raise({
      kind,
      entityType: 'company',
      entityId,
      detail: detail(),
    });

    expect(second.id).not.toBe(first.id);
    // Recurrence starts its own count — it is a new problem, not a continuation.
    expect(second.occurrences).toBe(1);
    expect(await rawRows([kind])).toHaveLength(2);
  });
});

describe('adminAlertsRepository.reconcileKind', () => {
  it('inserts, bumps and resolves across two ticks — and the sweep close writes NO resolver and NO note', async () => {
    const kind = `test.tick.${randomUUID()}`;
    const entityA = randomUUID();
    const entityB = randomUUID();
    const tick1At = new Date('2026-03-01T00:00:00.000Z');
    const tick2At = new Date('2026-03-01T00:01:00.000Z');

    const first = await adminAlertsRepository.reconcileKind(
      tick({
        kind,
        found: [finding(entityA, 'A is broken'), finding(entityB, 'B is broken')],
        now: tick1At,
      })
    );
    expect(first).toMatchObject({ inserted: 2, bumped: 0, resolved: 0, stormed: false, found: 2 });

    const second = await adminAlertsRepository.reconcileKind(
      tick({ kind, found: [finding(entityA, 'A is STILL broken')], now: tick2At })
    );
    expect(second).toMatchObject({ inserted: 0, bumped: 1, resolved: 1, stormed: false, found: 1 });

    const rows = await rawRows([kind]);
    const rowA = rows.find((row) => row.entityId === entityA);
    const rowB = rows.find((row) => row.entityId === entityB);
    if (rowA === undefined || rowB === undefined) {
      throw new Error('expected one row per seeded entity');
    }

    // A: still found ⇒ refreshed evidence and sighting, and `occurrences` UNCHANGED. A sweep
    // tick is not a new occurrence.
    expect(rowA.resolvedAt).toBeNull();
    expect(rowA.occurrences).toBe(1);
    expect(rowA.lastSeenAt.getTime()).toBe(tick2At.getTime());
    expect(rowA.firstSeenAt.getTime()).toBe(tick1At.getTime());
    expect(rowA.detail.evidence).toBe('A is STILL broken');

    // ⚠⚠ B: gone ⇒ auto-closed. The statement above ran against the REAL
    // `admin_alerts_manual_close_carries_a_note` CHECK, so this is proof the sweep's close
    // shape is legal, not merely that the columns read back the way we hoped.
    expect(rowB.resolvedAt?.getTime()).toBe(tick2At.getTime());
    expect(rowB.resolvedByUserId).toBeNull();
    expect(rowB.resolutionNote).toBeNull();
  });

  it('a resolved row is NEVER reopened — the next tick that finds it again inserts a new row', async () => {
    const kind = `test.reopen.${randomUUID()}`;
    const entityId = randomUUID();

    await adminAlertsRepository.reconcileKind(
      tick({ kind, found: [finding(entityId, 'v1')], now: new Date('2026-03-02T00:00:00.000Z') })
    );
    await adminAlertsRepository.reconcileKind(
      tick({ kind, found: [], now: new Date('2026-03-02T00:01:00.000Z') })
    );
    const third = await adminAlertsRepository.reconcileKind(
      tick({ kind, found: [finding(entityId, 'v2')], now: new Date('2026-03-02T00:02:00.000Z') })
    );

    expect(third).toMatchObject({ inserted: 1, bumped: 0, resolved: 0 });
    const rows = await rawRows([kind]);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.resolvedAt === null)).toHaveLength(1);
  });

  /**
   * The storm arm, both directions. `stormThreshold` is lowered to 2 so the case costs three
   * rows instead of twenty-six — the property under test is the THRESHOLD COMPARISON and the
   * pseudo-entity resolve, neither of which depends on the production constant.
   */
  it('above the storm threshold: ZERO per-entity rows and ONE sentinel storm row; the next calm tick resolves it and the per-entity rows resume', async () => {
    const kind = `test.storm.${randomUUID()}`;
    const stormKind = `${kind}.storm`;
    const entities = [randomUUID(), randomUUID(), randomUUID()];

    const stormy = await adminAlertsRepository.reconcileKind(
      tick({
        kind,
        found: entities.map((entityId) => finding(entityId, 'broken')),
        now: new Date('2026-03-03T00:00:00.000Z'),
        stormThreshold: 2,
      })
    );

    expect(stormy.stormed).toBe(true);
    expect(stormy.inserted).toBe(0);
    expect(await rawRows([kind])).toHaveLength(0);

    const stormRows = await rawRows([stormKind]);
    expect(stormRows).toHaveLength(1);
    const [stormRow] = stormRows;
    if (stormRow === undefined) {
      throw new Error('expected a storm row');
    }
    expect(stormRow.entityId).toBe(SENTINEL_ENTITY_ID);
    expect(stormRow.entityType).toBe('sweep');
    expect(stormRow.resolvedAt).toBeNull();
    // A-F9 — the kind is a PARENTHETICAL, never the sentence subject.
    expect(stormRow.detail.title).toBe(`3 new findings in one sweep (${kind})`);
    expect(stormRow.detail.title.startsWith(kind)).toBe(false);
    // The count and up to `stormSampleLimit` sample ids are the whole evidence.
    expect(stormRow.detail.facts).toContainEqual(['New this tick', '3']);
    const samples = stormRow.detail.facts.find(([label]) => label === 'Sample entity ids');
    expect(samples?.[1]).toContain(entities[0] ?? '');

    // Back under the threshold: per-entity rows resume AND the storm row closes itself,
    // because it is a pseudo-entity that is "found" iff the tick stormed.
    const calm = await adminAlertsRepository.reconcileKind(
      tick({
        kind,
        found: [finding(entities[0] ?? '', 'broken')],
        now: new Date('2026-03-03T00:01:00.000Z'),
        stormThreshold: 2,
      })
    );

    expect(calm.stormed).toBe(false);
    expect(calm.inserted).toBe(1);
    expect(calm.resolved).toBe(1);

    const closedStorm = await rawRow(stormRow.id);
    expect(closedStorm?.resolvedAt).not.toBeNull();
    expect(closedStorm?.resolvedByUserId).toBeNull();
    expect(closedStorm?.resolutionNote).toBeNull();
  });

  /**
   * ⚠⚠ A-F4 — THE BOUNDARY CASE, previously untested anywhere in this suite. Every existing
   * storm test uses 3 findings against threshold 2, or 1 against threshold 2 — never exactly
   * `found.length === stormThreshold`, the ONE value that distinguishes `>` from `>=`. ADR-1055
   * says "MORE THAN `STORM_THRESHOLD`": exactly-at-threshold must NOT storm. Mutating `>` to
   * `>=` in the repository leaves every OTHER test in this file green; only this one catches it.
   */
  it('exactly AT the storm threshold does NOT storm — per-entity rows insert normally, zero storm rows', async () => {
    const kind = `test.storm.boundary.${randomUUID()}`;
    const stormKind = `${kind}.storm`;
    const entities = [randomUUID(), randomUUID()]; // exactly 2, threshold 2.

    const result = await adminAlertsRepository.reconcileKind(
      tick({
        kind,
        found: entities.map((entityId) => finding(entityId, 'broken')),
        now: new Date('2026-03-03T12:00:00.000Z'),
        stormThreshold: 2,
      })
    );

    expect(result.stormed).toBe(false);
    expect(result.inserted).toBe(2);

    const rows = await rawRows([kind]);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.resolvedAt === null)).toBe(true);

    expect(await rawRows([stormKind])).toHaveLength(0);
  });

  it('a storm that persists bumps the SAME sentinel row rather than inserting a second one, and does NOT touch occurrences', async () => {
    const kind = `test.storm.persist.${randomUUID()}`;
    const stormKind = `${kind}.storm`;
    const found = [randomUUID(), randomUUID(), randomUUID()].map((id) => finding(id, 'broken'));

    await adminAlertsRepository.reconcileKind(
      tick({ kind, found, now: new Date('2026-03-04T00:00:00.000Z'), stormThreshold: 2 })
    );
    await adminAlertsRepository.reconcileKind(
      tick({ kind, found, now: new Date('2026-03-04T00:01:00.000Z'), stormThreshold: 2 })
    );

    const stormRows = await rawRows([stormKind]);
    expect(stormRows).toHaveLength(1);
    const [stormRow] = stormRows;
    if (stormRow === undefined) {
      throw new Error('expected a storm row');
    }
    // A storm is finder-DETECTED, not an event that recurred.
    expect(stormRow.occurrences).toBe(1);
    expect(stormRow.lastSeenAt.getTime()).toBe(new Date('2026-03-04T00:01:00.000Z').getTime());
  });

  /**
   * ⚠⚠ A-F3 — RULED: population-based, not new-ness-based. This is the test that actually
   * distinguishes the two rules: `newOnes.length > stormThreshold` (the old, STICKY rule) and
   * `input.found.length > stormThreshold` (the fix) agree on every OTHER storm test in this
   * file, because every other one either has zero pre-existing open rows or repeats the exact
   * same found set tick over tick. Here three entities are an EXISTING backlog (not new to
   * this call) and only one is new — `newOnes.length` is 1 (not > 2), but the total found
   * population is 4 (> 2). Only the population-based rule storms.
   */
  it('storms on the FOUND POPULATION even when almost none of it is NEW — a genuine backlog storms too', async () => {
    const kind = `test.storm.population.${randomUUID()}`;
    const stormKind = `${kind}.storm`;

    // A standing backlog: three entities that ALREADY have their own open rows.
    const backlog = await Promise.all([raiseOn(kind), raiseOn(kind), raiseOn(kind)]);
    const newEntity = randomUUID();

    const result = await adminAlertsRepository.reconcileKind(
      tick({
        kind,
        found: [
          ...backlog.map((row) => finding(row.entityId, 'still broken')),
          finding(newEntity, 'newly broken'),
        ],
        now: new Date('2026-03-04T12:00:00.000Z'),
        stormThreshold: 2,
      })
    );

    // ⚠⚠ THE PROPERTY: only 1 of 4 is NEW (not > 2), but the total found population (4) IS
    // > 2 — this storms. Under the old `newOnes.length > stormThreshold` rule it would not.
    expect(result.stormed).toBe(true);
    // The new entity's own row is suppressed by the storm — never inserted.
    expect(result.inserted).toBe(0);
    // The backlog is STILL bumped — a storm never freezes rows a person is already working.
    expect(result.bumped).toBe(3);

    expect(await rawRows([stormKind])).toHaveLength(1);
    const newRow = (await rawRows([kind])).find((row) => row.entityId === newEntity);
    expect(newRow).toBeUndefined();
  });

  it('reconciles ONLY its own kind — a sibling kind’s open rows are untouched', async () => {
    const mine = `test.scope.mine.${randomUUID()}`;
    const theirs = `test.scope.theirs.${randomUUID()}`;
    const entityId = randomUUID();

    await adminAlertsRepository.reconcileKind(
      tick({ kind: theirs, found: [finding(entityId, 'x')], now: new Date('2026-03-05T00:00:00Z') })
    );
    await adminAlertsRepository.reconcileKind(
      tick({ kind: mine, found: [], now: new Date('2026-03-05T00:01:00.000Z') })
    );

    const [theirRow] = await rawRows([theirs]);
    expect(theirRow?.resolvedAt).toBeNull();
  });

  /**
   * ⚠⚠ A-F2 — REAL, NOT MOCKED. `admin-alert-sweep.test.ts`'s "two filled batches…" test mocks
   * `reconcileKind` entirely and passes an EMPTY findings list — it cannot and does not prove
   * this property. This test is the one thing standing between the fix and a regression: seed
   * MORE open rows than the (simulated) finder batch cap, run a tick whose `found` covers only
   * the in-cap subset with `batchFilled: true`, and assert the OUT-OF-CAP rows are STILL OPEN
   * afterward — not silently auto-closed with no audit row.
   */
  it('batchFilled: true short-circuits the resolve arm — out-of-cap rows stay open, insert/bump still flow', async () => {
    const kind = `test.batchfilled.${randomUUID()}`;
    const tick1At = new Date('2026-03-06T00:00:00.000Z');
    const tick2At = new Date('2026-03-06T00:01:00.000Z');

    // Seed FIVE open rows — standing in for a backlog bigger than the finder's batch cap.
    const entities = Array.from({ length: 5 }, () => randomUUID());
    const seeded = await adminAlertsRepository.reconcileKind(
      tick({ kind, found: entities.map((id) => finding(id, 'broken at seed')), now: tick1At })
    );
    expect(seeded.inserted).toBe(5);

    // The "in-cap" subset: only the first THREE of the five, PLUS one brand-new entity — a
    // saturated finder still returns *some* real findings, some old, some new. `batchFilled:
    // true` because the finder hit its cap before it could look at the other two.
    const inCapExisting = entities.slice(0, 3);
    const newEntity = randomUUID();
    const tick2 = await adminAlertsRepository.reconcileKind(
      tick({
        kind,
        found: [
          ...inCapExisting.map((id) => finding(id, 'still broken')),
          finding(newEntity, 'newly broken, inside the cap'),
        ],
        now: tick2At,
        batchFilled: true,
      })
    );

    // ⚠⚠ THE PROPERTY: zero resolves, even though two seeded entities are absent from `found`.
    expect(tick2.resolved).toBe(0);
    // Insert and bump are UNAFFECTED by batchFilled — new/still-true findings keep flowing.
    expect(tick2.inserted).toBe(1);
    expect(tick2.bumped).toBe(3);

    const rows = await rawRows([kind]);
    expect(rows).toHaveLength(6); // 5 seeded + 1 new; nothing resolved, nothing lost.

    const outOfCap = entities.slice(3);
    for (const entityId of outOfCap) {
      const row = rows.find((r) => r.entityId === entityId);
      expect(row, `expected an open row for out-of-cap entity ${entityId}`).toBeDefined();
      // ⚠⚠ STILL OPEN — this is the bug A-F2 fixes. Before the fix, these were silently
      // stamped resolved_at = now with resolved_by_user_id = NULL: indistinguishable from a
      // real close, with no audit row.
      expect(row?.resolvedAt).toBeNull();
      // Untouched by this tick — still carries the SEED evidence, not bumped.
      expect(row?.detail.evidence).toBe('broken at seed');
      expect(row?.lastSeenAt.getTime()).toBe(tick1At.getTime());
    }

    for (const entityId of inCapExisting) {
      const row = rows.find((r) => r.entityId === entityId);
      expect(row?.resolvedAt).toBeNull();
      expect(row?.detail.evidence).toBe('still broken');
      expect(row?.lastSeenAt.getTime()).toBe(tick2At.getTime());
    }

    const newRow = rows.find((r) => r.entityId === newEntity);
    expect(newRow?.resolvedAt).toBeNull();
    expect(newRow?.firstSeenAt.getTime()).toBe(tick2At.getTime());
  });
});

describe('adminAlertsRepository.listOpenPage', () => {
  /**
   * ⚠ SMALL NUMBERS ON PURPOSE. The property is that a KEYSET cursor is a position in the
   * sort, not an offset — so resolving a row from page 1 between requests can neither
   * duplicate nor skip a row on page 2. Six rows and a page size of three prove exactly that,
   * for a fraction of the runtime of sixty.
   */
  it('pages by keyset with no duplicate and no skip, even when a page-1 row resolves between pages', async () => {
    const kind = `test.paging.${randomUUID()}`;
    const base = Date.parse('2026-04-01T00:00:00.000Z');
    const ids: string[] = [];

    for (let index = 0; index < 6; index += 1) {
      const row = await adminAlertsRepository.raise({
        kind,
        entityType: 'company',
        entityId: randomUUID(),
        detail: detail({ title: `row ${index}` }),
      });
      // `first_seen_at` defaults to `now()` = transaction START time inside the harness, so
      // every row would otherwise share a byte-identical sort key.
      await db
        .update(adminAlerts)
        .set({ firstSeenAt: new Date(base + index * 60_000) })
        .where(eq(adminAlerts.id, row.id));
      ids.push(row.id);
    }

    const page1 = await adminAlertsRepository.listOpenPage({ kinds: [kind], limit: 3 });
    expect(page1.hasMore).toBe(true);
    expect(page1.alerts.map((alert) => alert.id)).toEqual(ids.slice(0, 3));

    // A responder closes the FIRST row while looking at page 1.
    const [firstId] = ids;
    if (firstId === undefined) {
      throw new Error('expected seeded ids');
    }
    await db
      .update(adminAlerts)
      .set({ resolvedAt: new Date('2026-04-02T00:00:00.000Z') })
      .where(eq(adminAlerts.id, firstId));

    const cursorRow = page1.alerts[2];
    if (cursorRow === undefined) {
      throw new Error('expected a full first page');
    }
    const page2 = await adminAlertsRepository.listOpenPage({
      kinds: [kind],
      after: { firstSeenAt: cursorRow.firstSeenAt, id: cursorRow.id },
      limit: 3,
    });

    expect(page2.hasMore).toBe(false);
    expect(page2.alerts.map((alert) => alert.id)).toEqual(ids.slice(3));
  });

  it('excludes resolved and soft-deleted rows, and returns oldest-first', async () => {
    const kind = `test.open-only.${randomUUID()}`;
    const open = await raiseOn(kind);
    const resolved = await raiseOn(kind);
    const deleted = await raiseOn(kind);
    await markResolvedRaw(resolved.id);
    await markDeletedRaw(deleted.id);

    const page = await adminAlertsRepository.listOpenPage({ kinds: [kind], limit: 10 });
    expect(page.alerts.map((alert) => alert.id)).toEqual([open.id]);
  });

  it('an EMPTY kinds array returns empty without a query', async () => {
    const page = await adminAlertsRepository.listOpenPage({ kinds: [], limit: 10 });
    expect(page).toEqual({ alerts: [], hasMore: false });
  });
});

describe('adminAlertsRepository.countOpenByKind', () => {
  it('is exact per kind and excludes resolved and soft-deleted rows', async () => {
    const kind = `test.count.${randomUUID()}`;
    const keep = await raiseOn(kind);
    const alsoKeep = await raiseOn(kind);
    const resolved = await raiseOn(kind);
    const deleted = await raiseOn(kind);
    await markResolvedRaw(resolved.id);
    await markDeletedRaw(deleted.id);

    const oldest = new Date('2026-05-01T00:00:00.000Z');
    await db.update(adminAlerts).set({ firstSeenAt: oldest }).where(eq(adminAlerts.id, keep.id));
    await db
      .update(adminAlerts)
      .set({ firstSeenAt: new Date('2026-05-02T00:00:00.000Z') })
      .where(eq(adminAlerts.id, alsoKeep.id));

    const counts = await adminAlertsRepository.countOpenByKind();
    const mine = counts.find((row) => row.kind === kind);

    expect(mine?.count).toBe(2);
    expect(mine?.oldestFirstSeenAt.getTime()).toBe(oldest.getTime());
  });
});

describe('adminAlertsRepository.close', () => {
  const NOTE = 'Refunded the remainder and credited the wallet.';

  it('writes the resolution AND its audit row in one transaction', async () => {
    const actor = await userFactory({ platformRole: 'admin' });
    const kind = `test.close.${randomUUID()}`;
    const subjectEntityId = randomUUID();
    const raised = await adminAlertsRepository.raise({
      kind,
      entityType: 'wallet',
      entityId: subjectEntityId,
      detail: detail(),
    });

    const result = await adminAlertsRepository.close({
      alertId: raised.id,
      actorUserId: actor.id,
      note: NOTE,
      noteCloseableKinds: [kind],
    });

    expect(result.outcome).toBe('closed');
    if (result.outcome !== 'closed') {
      throw new Error('expected a close');
    }
    expect(result.alert.resolvedAt).not.toBeNull();
    expect(result.alert.resolvedByUserId).toBe(actor.id);
    expect(result.alert.resolutionNote).toBe(NOTE);

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.id, result.auditId), eq(auditEvents.action, 'admin_alert.closed')));
    expect(audit?.entityType).toBe('admin_alert');
    // The audit row names the ALERT; its metadata names the alert's SUBJECT.
    expect(audit?.entityId).toBe(raised.id);
    expect(audit?.metadata).toEqual({
      kind,
      subjectEntityType: 'wallet',
      subjectEntityId,
      occurrences: 1,
    });
    // ⚠ THE NOTE IS NOT IN THE APPEND-ONLY TRAIL. Asserted on the SERIALISED row, so an
    // unexpected key cannot hide it.
    expect(JSON.stringify(audit)).not.toContain(NOTE);
  });

  it('refuses a FINDER kind and writes nothing at all — not even an audit row', async () => {
    const actor = await userFactory({ platformRole: 'admin' });
    const kind = `test.close.finder.${randomUUID()}`;
    const raised = await adminAlertsRepository.raise({
      kind,
      entityType: 'company',
      entityId: randomUUID(),
      detail: detail(),
    });

    const result = await adminAlertsRepository.close({
      alertId: raised.id,
      actorUserId: actor.id,
      note: NOTE,
      // The kind is absent from the note-closeable set ⇒ the sweep owns it.
      noteCloseableKinds: ['some.other.kind'],
    });

    expect(result).toEqual({ outcome: 'finder_kind', kind });
    const untouched = await rawRow(raised.id);
    expect(untouched?.resolvedAt).toBeNull();
    expect(untouched?.resolutionNote).toBeNull();

    const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityId, raised.id));
    expect(audits).toHaveLength(0);
  });

  it('a second close answers already_resolved and changes nothing', async () => {
    const actor = await userFactory({ platformRole: 'admin' });
    const other = await userFactory({ platformRole: 'admin' });
    const kind = `test.close.twice.${randomUUID()}`;
    const raised = await adminAlertsRepository.raise({
      kind,
      entityType: 'company',
      entityId: randomUUID(),
      detail: detail(),
    });

    await adminAlertsRepository.close({
      alertId: raised.id,
      actorUserId: actor.id,
      note: NOTE,
      noteCloseableKinds: [kind],
    });
    const second = await adminAlertsRepository.close({
      alertId: raised.id,
      actorUserId: other.id,
      note: 'a different note',
      noteCloseableKinds: [kind],
    });

    expect(second).toEqual({ outcome: 'already_resolved' });
    const row = await rawRow(raised.id);
    expect(row?.resolvedByUserId).toBe(actor.id);
    expect(row?.resolutionNote).toBe(NOTE);
  });

  it('answers not_found for an unknown id and for a soft-deleted row alike', async () => {
    const actor = await userFactory({ platformRole: 'admin' });
    const kind = `test.close.gone.${randomUUID()}`;
    const raised = await raiseOn(kind);
    await markDeletedRaw(raised.id);

    expect(
      await adminAlertsRepository.close({
        alertId: randomUUID(),
        actorUserId: actor.id,
        note: NOTE,
        noteCloseableKinds: [kind],
      })
    ).toEqual({ outcome: 'not_found' });

    expect(
      await adminAlertsRepository.close({
        alertId: raised.id,
        actorUserId: actor.id,
        note: NOTE,
        noteCloseableKinds: [kind],
      })
    ).toEqual({ outcome: 'not_found' });
  });
});

describe('admin_alerts CHECK constraints', () => {
  /**
   * ⚠ EACH PROBE RUNS IN ITS OWN SAVEPOINT via `expectConstraintViolation`. A raw failed
   * statement on the outer per-test transaction would abort it and every later statement would
   * answer `25P02` instead of the code under test.
   */
  it('rejects a resolver with no note (a person must say what they did)', async () => {
    const actor = await userFactory({ platformRole: 'admin' });
    const raised = await adminAlertsRepository.raise({
      kind: `test.check.a.${randomUUID()}`,
      entityType: 'company',
      entityId: randomUUID(),
      detail: detail(),
    });

    await expectConstraintViolation('23514', (tx) =>
      tx
        .update(adminAlerts)
        .set({ resolvedAt: new Date(), resolvedByUserId: actor.id })
        .where(eq(adminAlerts.id, raised.id))
    );
  });

  it('rejects a note with no resolver (the sweep closes with NEITHER)', async () => {
    const raised = await adminAlertsRepository.raise({
      kind: `test.check.b.${randomUUID()}`,
      entityType: 'company',
      entityId: randomUUID(),
      detail: detail(),
    });

    await expectConstraintViolation('23514', (tx) =>
      tx
        .update(adminAlerts)
        .set({ resolvedAt: new Date(), resolutionNote: 'closed by nobody' })
        .where(eq(adminAlerts.id, raised.id))
    );
  });

  it('rejects a resolver on an UNRESOLVED row', async () => {
    const actor = await userFactory({ platformRole: 'admin' });
    const raised = await adminAlertsRepository.raise({
      kind: `test.check.c.${randomUUID()}`,
      entityType: 'company',
      entityId: randomUUID(),
      detail: detail(),
    });

    await expectConstraintViolation('23514', (tx) =>
      tx
        .update(adminAlerts)
        .set({ resolvedByUserId: actor.id, resolutionNote: 'note without a resolution' })
        .where(eq(adminAlerts.id, raised.id))
    );
  });

  it('rejects occurrences below 1', async () => {
    const raised = await adminAlertsRepository.raise({
      kind: `test.check.d.${randomUUID()}`,
      entityType: 'company',
      entityId: randomUUID(),
      detail: detail(),
    });

    await expectConstraintViolation('23514', (tx) =>
      tx.update(adminAlerts).set({ occurrences: 0 }).where(eq(adminAlerts.id, raised.id))
    );
  });

  it('the open partial-unique admits a SECOND row only once the first is resolved', async () => {
    const kind = `test.check.uidx.${randomUUID()}`;
    const entityId = randomUUID();
    await adminAlertsRepository.raise({
      kind,
      entityType: 'company',
      entityId,
      detail: detail(),
    });

    await expectConstraintViolation('23505', (tx) =>
      tx.insert(adminAlerts).values({
        kind,
        entityType: 'company',
        entityId,
        detail: detail(),
      })
    );
  });
});

describe('adminSweepTicksRepository', () => {
  it('markTick inserts, then UPDATES the same cadence row (upsert on the primary key)', async () => {
    const first = new Date('2026-06-01T00:00:00.000Z');
    const second = new Date('2026-06-01T00:05:00.000Z');

    await adminSweepTicksRepository.markTick('5m', first);
    await adminSweepTicksRepository.markTick('5m', second);

    const rows = await db.select().from(adminSweepTicks).where(eq(adminSweepTicks.cadence, '5m'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastTickAt.getTime()).toBe(second.getTime());
  });

  it('listTicks returns every cadence that has run', async () => {
    await adminSweepTicksRepository.markTick('15m', new Date('2026-06-02T00:00:00.000Z'));
    await adminSweepTicksRepository.markTick('1m', new Date('2026-06-02T00:01:00.000Z'));

    const ticks = await adminSweepTicksRepository.listTicks();
    const cadences = ticks.map((row) => row.cadence);
    // ⚠ Only the MEMBERSHIP is asserted, not the sequence: `orderBy(asc(cadence))` is
    // Postgres's text collation, and pinning it here would be a test of the database's
    // locale, not of this repository. The page sorts by cadence LENGTH anyway.
    expect(new Set(cadences)).toEqual(new Set(['1m', '15m']));
  });
});
