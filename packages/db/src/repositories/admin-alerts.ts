import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AdminAlertDetail } from '@balo/shared/admin-alerts';
import { db } from '../client';
import { adminAlerts, adminSweepTicks } from '../schema';
import type { AdminAlert, AdminSweepTick } from '../schema';
import { auditEventsRepository } from './audit-events';
import type { DbExecutor } from './_shared/db-executor';

// ── Inputs / results ───────────────────────────────────────────────────────

/** One finding a finder produced this tick — everything needed to insert or refresh a row. */
export interface AdminAlertFinding {
  readonly entityType: string;
  readonly entityId: string;
  readonly detail: AdminAlertDetail;
}

/** One event-driven raise. See {@link adminAlertsRepository.raise}. */
export interface RaiseAdminAlertInput {
  readonly kind: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly detail: AdminAlertDetail;
}

/**
 * One kind's whole reconcile for one sweep tick.
 *
 * ⚠ EVERY REGISTRY-DERIVED VALUE ARRIVES AS DATA. `@balo/db` must not interpret the kind
 * registry any more than it interprets a role — the `internal-notes.ts` `allowAnyAuthor`
 * precedent. The sweep resolves `stormKind` (`stormKindFor(kind)`) and `sentinelEntityId`
 * from `@balo/shared/admin-alerts` and hands them over; this repository compares data to data.
 */
export interface ReconcileKindInput {
  readonly kind: string;
  /** ⚠ THE COMPLETE, CURRENT truth for this kind. Anything absent from it gets RESOLVED. */
  readonly found: readonly AdminAlertFinding[];
  /** Above this many NEW entities in one tick, the per-entity rows are replaced by one storm row. */
  readonly stormThreshold: number;
  /** How many sample entity ids a storm row's `detail` carries. */
  readonly stormSampleLimit: number;
  /** `stormKindFor(kind)` — passed in so this repository interprets no registry vocabulary. */
  readonly stormKind: string;
  /** The sweep sentinel a storm row is keyed on. Passed in for the same reason. */
  readonly sentinelEntityId: string;
  /** ⚠ ONE instant for the whole tick, so a bump and a resolve in it are not skewed. */
  readonly now: Date;
  /**
   * ⚠⚠ A-F2 — true when the finder FILLED its batch bound (`ADMIN_ALERT_FINDER_BATCH_LIMIT`).
   * `found` is then a PARTIAL truth, not the complete one the resolve arm's contract requires
   * (see the "COMPLETE, CURRENT truth" note above) — an entity absent from a saturated `found`
   * may simply be past the cap, never examined this tick, not actually gone. `reconcileKind`
   * short-circuits the RESOLVE arm ONLY when this is true: insert and bump still run, so new
   * and still-true findings keep flowing — only "stop closing rows I never actually looked at"
   * is suppressed.
   */
  readonly batchFilled: boolean;
}

export interface ReconcileKindResult {
  readonly inserted: number;
  readonly bumped: number;
  readonly resolved: number;
  readonly stormed: boolean;
  /** How many entities the finder returned — the caller warns when it equals its batch bound. */
  readonly found: number;
}

export interface CloseAdminAlertInput {
  readonly alertId: string;
  readonly actorUserId: string;
  readonly note: string;
  /**
   * ⚠ AN ALREADY-RESOLVED POLICY SET, NEVER A REGISTRY IMPORT — same rule as
   * {@link ReconcileKindInput}. The Server Action derives this from
   * `@balo/shared/admin-alerts` (`NOTE_CLOSEABLE_KINDS`) and hands over data.
   */
  readonly noteCloseableKinds: readonly string[];
}

/**
 * A DISCRIMINATED UNION, not a throw: every failure arm is an ordinary product state the
 * action renders as copy. ⚠ EVERY REFUSAL ARM WRITES NOTHING — not even an audit row. A
 * refusal is not an event (the `internalNotesRepository.softDelete` posture).
 */
export type CloseAdminAlertOutcome =
  | { outcome: 'closed'; alert: AdminAlert; auditId: string }
  | { outcome: 'not_found' }
  | { outcome: 'already_resolved' }
  | { outcome: 'finder_kind'; kind: string };

/** One tile/header aggregate row. The PAGE folds `kind` → group through the registry. */
export interface AdminAlertKindCount {
  readonly kind: string;
  readonly count: number;
  readonly oldestFirstSeenAt: Date;
}

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * ⚠⚠ THE ARBITER PREDICATE, RESTATED AS RAW SQL, AND IT MUST MATCH `admin_alerts_open_uidx`
 * EXACTLY.
 *
 * Postgres only selects a PARTIAL unique index as an `ON CONFLICT` arbiter when the statement
 * REPEATS its predicate. Omit it — or write it in a form the planner cannot prove implies the
 * index predicate — and EVERY upsert raises **42P10, "there is no unique or exclusion
 * constraint matching the ON CONFLICT specification"**, at PLAN time: on the first statement,
 * on an empty table, with `tsc` green and any mocked unit test green (a mocked Drizzle client
 * only records the argument and never reaches a planner). Only an integration test that
 * actually hits the CONFLICT path can catch it — which is why
 * `admin-alerts.integration.test.ts` raises the SAME (kind, entity) twice.
 *
 * ⚠ WRITTEN AS RAW LITERALS RATHER THAN `and(isNull(…), isNull(…))` ON PURPOSE. Drizzle's
 * `isNull()` happens to render parameter-free SQL, so the sibling upserts
 * (`calendarRepository.upsertApirocConnection`,
 * `meetingCalendarEventsRepository.recordProviderEvent`) are correct as they stand — but any
 * predicate term that binds a `$n` parameter (an `eq()` against a literal, say) can NEVER
 * match an index predicate, and Postgres reports it as the same runtime 42P10 (memory
 * `reference_pg_partial_index_arbiter_param_42p10`). This form is textually identical to the
 * index and cannot acquire a parameter by a later edit. Both clauses name TIMESTAMP COLUMNS
 * only — the house rule the index docblock states.
 */
const OPEN_ROW_ARBITER = sql`resolved_at IS NULL AND deleted_at IS NULL`;

/** The open-row predicate for ordinary reads (a query, not an arbiter — Drizzle form is fine). */
function openRowPredicate(): ReturnType<typeof and> {
  return and(isNull(adminAlerts.resolvedAt), isNull(adminAlerts.deletedAt));
}

/**
 * The storm row's evidence snapshot.
 *
 * ⚠ THIS IS THE ONE PLACE THIS PACKAGE COMPOSES A `detail`, AND EVERY FIELD IS MECHANICALLY
 * DERIVED FROM ARGUMENTS IT WAS HANDED — the kind string, two counts, a list of ids. It reads
 * no registry, resolves no copy and makes no judgement about what the kind MEANS; the storm
 * row exists precisely because the per-entity findings were suppressed, so no finder-authored
 * detail is available to carry forward.
 *
 * ⚠ A-F9 — THE KIND SITS IN A PARENTHETICAL, NEVER AS THE SENTENCE SUBJECT. Every other title
 * in this system is a natural-language sentence a person understands (ADR-1055); the dotted
 * `kind` key is a technical identifier, not a subject — "recording.failed: 42 new findings"
 * read as data leaking into copy. This is the row most likely to appear during a real
 * incident, so the composition stays HERE (deliberately, per B1) rather than moving into a
 * kind→label map — the phrasing change alone is the minimal fix.
 */
function buildStormDetail(input: {
  kind: string;
  newCount: number;
  stormThreshold: number;
  sampleEntityIds: readonly string[];
}): AdminAlertDetail {
  const samples = input.sampleEntityIds.join(', ');
  return {
    title: `${input.newCount} new findings in one sweep (${input.kind})`,
    entityLabel: 'The alert sweep',
    evidence:
      `The finder for ${input.kind} returned ${input.newCount} entities with no open row, ` +
      `above the ${input.stormThreshold} allowed in one tick. Per-entity rows are held back ` +
      `until the count comes back down, and this row closes itself when it does.`,
    facts: [
      ['Kind', input.kind],
      ['New this tick', String(input.newCount)],
      ['Storm threshold', String(input.stormThreshold)],
      ['Sample entity ids', samples.length > 0 ? samples : 'none'],
    ],
  };
}

/**
 * A raw `min()`/`count()` aggregate is not routed through the column's driver mapper, so the
 * value arrives as whatever `postgres-js` decoded — a `Date` today, a string if that ever
 * changes. The `creditReceivablesRepository.earliestOpenDebtAnchor` guard, verbatim.
 */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

// ── The queue ──────────────────────────────────────────────────────────────

/**
 * `adminAlertsRepository` (BAL-548 / ADR-1055) — THE ONLY ACCESS PATH TO `admin_alerts`. See
 * `schema/admin-alerts.ts` for the table's doctrine; the rules that bind THIS file:
 *
 * ⚠⚠ READS NEVER WRITE (ADR-1055 D3). Not one method here resolves, closes or clears an alert
 * as a SIDE EFFECT of anything. There are exactly two ways a row leaves the queue:
 * {@link adminAlertsRepository.reconcileKind} (the sweep stopped finding the condition) and
 * {@link adminAlertsRepository.close} (a person wrote a note). A source-scanning invariant
 * fences the call sites of both.
 *
 * ⚠ A RESOLVED ROW IS NEVER REOPENED. Recurrence inserts a NEW row — which is what the partial
 * unique buys: resolving frees the (kind, entity) slot.
 *
 * ⚠ THIS REPOSITORY INTERPRETS NO REGISTRY VOCABULARY. Storm kind, sentinel, thresholds and
 * the note-closeable set all arrive as DATA (see {@link ReconcileKindInput}).
 *
 * ⚠ IT ALSO WRITES NO NOTIFICATION, NO ANALYTIC AND NO LOG LINE
 * (`invariants/repositories-never-notify.test.ts`). ADR-1055 is explicit: the queue IS the
 * notification.
 */
export const adminAlertsRepository = {
  /**
   * EVENT-DRIVEN RAISE — "this happened again". Inserts the row, or bumps the OPEN one for the
   * same (kind, entity).
   *
   * ⚠ `occurrences + 1` HAPPENS HERE AND NOWHERE ELSE. A sweep tick that re-finds a standing
   * condition is not a new occurrence; {@link reconcileKind} never touches the counter.
   *
   * ⚠ `detail` IS REPLACED, NOT MERGED — the newest evidence wins (ADR-1055).
   *
   * ⚠ `first_seen_at` IS NOT TOUCHED BY THE CONFLICT ARM. The row keeps its original age, which
   * is what the queue sorts on; a bump must not push a week-old row back to the bottom.
   *
   * ⚠⚠ THE `targetWhere` MUST STAY EXACTLY {@link OPEN_ROW_ARBITER} — read its docblock before
   * touching this. A resolved or soft-deleted row is invisible to the partial index, so it
   * cannot be the conflict target and a recurrence correctly INSERTS beside it.
   *
   * TX-COMPOSABLE: the raise sites sit inside the transaction of the thing that went wrong.
   */
  async raise(input: RaiseAdminAlertInput, exec: DbExecutor = db): Promise<AdminAlert> {
    const [row] = await exec
      .insert(adminAlerts)
      .values({
        kind: input.kind,
        entityType: input.entityType,
        entityId: input.entityId,
        detail: input.detail,
      })
      .onConflictDoUpdate({
        target: [adminAlerts.kind, adminAlerts.entityId],
        // ⚠⚠ Removing or parameterising this line breaks EVERY raise with 42P10 at runtime.
        targetWhere: OPEN_ROW_ARBITER,
        set: {
          occurrences: sql`${adminAlerts.occurrences} + 1`,
          lastSeenAt: new Date(),
          detail: input.detail,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (row === undefined) {
      throw new Error(`admin_alerts raise returned no row for kind ${input.kind}`);
    }
    return row;
  },

  /**
   * THE LEVEL-TRIGGERED RECONCILE for ONE finder kind, in ONE transaction: insert what is
   * newly true, refresh what is still true, and RESOLVE what has stopped being true.
   *
   * ⚠⚠ `found` IS THE COMPLETE CURRENT TRUTH FOR THIS KIND, AND ANYTHING ABSENT FROM IT IS
   * CLOSED. A finder that throws must therefore never reach this method with a partial list —
   * an empty `found` from a broken finder would mass-close the whole kind. The sweep's skip
   * rule (a kind whose finder threw, or whose feature is unconfigured, is not reconciled at
   * all) is what makes that safe, and it lives at the caller because only the caller can tell
   * "nothing is wrong" from "I could not look".
   *
   * ⚠ `occurrences` IS NEVER TOUCHED HERE. See {@link raise}.
   *
   * ⚠ THE STORM ARM SUPPRESSES INSERTS ONLY. Above `stormThreshold` entities FOUND in one tick
   * (A-F3 — the WHOLE found population, not just the newly-discovered ones; see below), none of
   * the new ones is inserted and ONE `<kind>.storm` row is upserted on the sentinel carrying the
   * count and up to `stormSampleLimit` sample ids. Entities that ALREADY have open rows are
   * still bumped, and entities that have gone away are still resolved — a storm must not freeze
   * the rows a person is already working.
   *
   * ⚠⚠ A-F3 — THE STORM DECISION IS POPULATION-BASED, NOT NEW-NESS-BASED, AND THAT IS
   * DELIBERATE. `stormed = input.found.length > input.stormThreshold` — never
   * `newOnes.length > input.stormThreshold`. A new-ness-based rule is STICKY: a suppressed
   * entity never gets a row, so it is still "new" next tick — forever. On a constant population
   * at or above the threshold that never un-storms, even after the backlog stops growing. The
   * population-based rule is self-correcting — the decision depends only on THIS tick's total
   * `found`, never on what the previous tick did — so it un-storms the moment the population
   * drops to at most `stormThreshold`, matching ADR-1055's "per-entity rows resume below the
   * threshold" and its stated intent ("if a hundred recordings fail in one go, the queue shows
   * one row saying so rather than a hundred").
   * ⚠ ACCEPTED COST, STATED SO IT IS NOT REDISCOVERED AS A BUG: a genuine backlog of MORE than
   * `stormThreshold` already-known, still-open entities ALSO renders as one storm row, even
   * though none of them is new. That is intended — the tile COUNT stays exact regardless (it is
   * a `countOpenByKind` read, untouched by this arm), and the kind's own list page is where a
   * real backlog gets worked entity-by-entity.
   *
   * ⚠ THE STORM ROW IS A PSEUDO-ENTITY THAT IS "FOUND" IFF `stormed`. That single rule is what
   * makes "per-entity rows resume once the count drops" true with no second mechanism: the
   * first calm tick resolves the storm row exactly the way it resolves any other row whose
   * condition has gone.
   *
   * ⚠⚠ A-F2 — THE RESOLVE ARM IS SHORT-CIRCUITED WHEN `input.batchFilled`. A saturated finder's
   * `found` is a PARTIAL truth: an entity outside the batch cap is simply unexamined, not gone.
   * Resolving it anyway would silently stamp `resolved_at` on a still-true condition, with no
   * audit row to say so. Insert and bump are UNAFFECTED — new and still-true findings inside the
   * batch keep flowing either way.
   *
   * ⚠⚠ A SWEEP CLOSE STAMPS `resolved_at` AND NOTHING ELSE — `resolved_by_user_id` and
   * `resolution_note` both stay NULL, which is precisely what
   * `admin_alerts_manual_close_carries_a_note` asserts (a person closes with BOTH, the sweep
   * with NEITHER). Writing a note here would violate that CHECK at RUNTIME, invisible to
   * `tsc`.
   */
  async reconcileKind(input: ReconcileKindInput): Promise<ReconcileKindResult> {
    return db.transaction(async (tx) => {
      // Rides `admin_alerts_open_uidx` (`kind` leading) for both kinds at once.
      const openRows = await tx
        .select({
          id: adminAlerts.id,
          kind: adminAlerts.kind,
          entityId: adminAlerts.entityId,
        })
        .from(adminAlerts)
        .where(and(inArray(adminAlerts.kind, [input.kind, input.stormKind]), openRowPredicate()));

      const openPerEntity = new Map(
        openRows.filter((row) => row.kind === input.kind).map((row) => [row.entityId, row.id])
      );
      const openStormRowIds = openRows
        .filter((row) => row.kind === input.stormKind)
        .map((row) => row.id);

      const newOnes = input.found.filter((finding) => !openPerEntity.has(finding.entityId));
      // A-F3 — RULED: population-based, not new-ness-based. See the method docblock.
      const stormed = input.found.length > input.stormThreshold;

      let inserted = 0;

      if (stormed) {
        // ONE storm row, on the sentinel. Same arbiter shape as `raise`, but `occurrences` is
        // deliberately NOT incremented: a storm is finder-DETECTED, not an event that recurred.
        await tx
          .insert(adminAlerts)
          .values({
            kind: input.stormKind,
            entityType: 'sweep',
            entityId: input.sentinelEntityId,
            detail: buildStormDetail({
              kind: input.kind,
              newCount: newOnes.length,
              stormThreshold: input.stormThreshold,
              sampleEntityIds: newOnes
                .slice(0, input.stormSampleLimit)
                .map((finding) => finding.entityId),
            }),
          })
          .onConflictDoUpdate({
            target: [adminAlerts.kind, adminAlerts.entityId],
            targetWhere: OPEN_ROW_ARBITER,
            set: {
              lastSeenAt: input.now,
              detail: buildStormDetail({
                kind: input.kind,
                newCount: newOnes.length,
                stormThreshold: input.stormThreshold,
                sampleEntityIds: newOnes
                  .slice(0, input.stormSampleLimit)
                  .map((finding) => finding.entityId),
              }),
              updatedAt: input.now,
            },
          });
      } else {
        for (const finding of newOnes) {
          // `onConflictDoNothing` on the SAME arbiter: a concurrent tick loses harmlessly.
          const rows = await tx
            .insert(adminAlerts)
            .values({
              kind: input.kind,
              entityType: finding.entityType,
              entityId: finding.entityId,
              detail: finding.detail,
              firstSeenAt: input.now,
              lastSeenAt: input.now,
            })
            .onConflictDoNothing({
              target: [adminAlerts.kind, adminAlerts.entityId],
              where: OPEN_ROW_ARBITER,
            })
            .returning({ id: adminAlerts.id });
          inserted += rows.length;
        }
      }

      // ── Bump: still true, so refresh the evidence and the sighting. NOT `occurrences`. ──
      //
      // ⚠ ONE STATEMENT PER ENTITY, BOUNDED BY THE FINDER'S OWN BATCH LIMIT (200). Each row
      // carries a DIFFERENT `detail`, so this cannot collapse into one UPDATE without a
      // hand-written `FROM (VALUES …)` join — raw SQL for a bound this small is the worse
      // trade. If a finder's bound ever grows by an order of magnitude, revisit it here.
      let bumped = 0;
      for (const finding of input.found) {
        const openId = openPerEntity.get(finding.entityId);
        if (openId === undefined) {
          continue;
        }
        await tx
          .update(adminAlerts)
          .set({ lastSeenAt: input.now, detail: finding.detail, updatedAt: input.now })
          .where(eq(adminAlerts.id, openId));
        bumped += 1;
      }

      // ── Resolve: no longer found. `resolved_by_user_id`/`resolution_note` stay NULL. ──
      //
      // ⚠⚠ A-F2 — SHORT-CIRCUITED TO EMPTY WHEN `input.batchFilled`. See the method docblock:
      // a saturated finder's `found` is a PARTIAL truth, and resolving against a partial list
      // would silently close rows for entities that are simply outside the batch cap, not gone.
      const foundEntityIds = new Set(input.found.map((finding) => finding.entityId));
      const toResolve = input.batchFilled
        ? []
        : [
            ...[...openPerEntity.entries()]
              .filter(([entityId]) => !foundEntityIds.has(entityId))
              .map(([, id]) => id),
            // The storm row is "found" iff this tick stormed.
            ...(stormed ? [] : openStormRowIds),
          ];

      let resolved = 0;
      if (toResolve.length > 0) {
        const resolvedRows = await tx
          .update(adminAlerts)
          .set({ resolvedAt: input.now, updatedAt: input.now })
          .where(and(inArray(adminAlerts.id, toResolve), openRowPredicate()))
          .returning({ id: adminAlerts.id });
        resolved = resolvedRows.length;
      }

      return { inserted, bumped, resolved, stormed, found: input.found.length };
    });
  },

  /**
   * THE HOME READ — one keyset page of OPEN rows, OLDEST FIRST.
   *
   * Keyset is STRICT `(first_seen_at, id) > (after.firstSeenAt, after.id)`: same-instant
   * neighbours are disambiguated by `id`, so repeated "load more" calls never duplicate or
   * skip a row EVEN IF a row from an earlier page is resolved between requests — the cursor is
   * a position in the sort, not an offset. Fetches `limit + 1` to derive `hasMore` without a
   * second COUNT. The `conversationsRepository.listMessagesPage` shape, inverted to ascending.
   * Rides `admin_alerts_open_keyset_idx`.
   *
   * ⚠ `kinds` IS A KIND FILTER, NOT A GROUP FILTER — `group` IS NOT A COLUMN. The registry is
   * the whole truth about kind → group, and the page folds it before calling.
   *
   * ⚠ AN EMPTY `kinds` ARRAY RETURNS EMPTY WITHOUT A QUERY. A bare `inArray(x, [])` is a
   * Drizzle footgun (it renders `false`-ish SQL in some versions and throws in others), and
   * "the caller asked for no kinds" has an unambiguous answer that needs no round trip.
   */
  async listOpenPage(input: {
    kinds?: readonly string[];
    after?: { firstSeenAt: Date; id: string };
    limit: number;
  }): Promise<{ alerts: AdminAlert[]; hasMore: boolean }> {
    if (input.kinds !== undefined && input.kinds.length === 0) {
      return { alerts: [], hasMore: false };
    }

    const rows = await db
      .select()
      .from(adminAlerts)
      .where(
        and(
          openRowPredicate(),
          input.kinds === undefined ? undefined : inArray(adminAlerts.kind, [...input.kinds]),
          input.after === undefined
            ? undefined
            : or(
                gt(adminAlerts.firstSeenAt, input.after.firstSeenAt),
                and(
                  eq(adminAlerts.firstSeenAt, input.after.firstSeenAt),
                  gt(adminAlerts.id, input.after.id)
                )
              )
        )
      )
      .orderBy(asc(adminAlerts.firstSeenAt), asc(adminAlerts.id))
      .limit(input.limit + 1);

    const hasMore = rows.length > input.limit;
    return { alerts: hasMore ? rows.slice(0, input.limit) : rows, hasMore };
  },

  /**
   * THE TILE + HEADER AGGREGATE — an EXACT count of open rows per kind, plus the age of the
   * oldest one. Index-only over `admin_alerts_open_uidx` (`kind` leads it).
   *
   * ⚠ EXACT, NOT ESTIMATED (ADR-1055). A queue whose tile says "about 12" is a queue nobody
   * trusts to be empty. Grouping by KIND rather than by group keeps the registry the single
   * place kind → group is decided; the page folds.
   */
  async countOpenByKind(): Promise<AdminAlertKindCount[]> {
    const rows = await db
      .select({
        kind: adminAlerts.kind,
        count: sql<number>`cast(count(*) as int)`,
        oldestFirstSeenAt: sql<Date | string>`min(${adminAlerts.firstSeenAt})`,
      })
      .from(adminAlerts)
      .where(openRowPredicate())
      .groupBy(adminAlerts.kind);

    return rows.map((row) => ({
      kind: row.kind,
      count: row.count,
      oldestFirstSeenAt: toDate(row.oldestFirstSeenAt),
    }));
  },

  /**
   * A PERSON CLOSES ONE EVENT-DRIVEN ROW, with a note. ONE transaction: lock the row FOR
   * UPDATE, decide, then write the resolution and its `admin_alert.closed` audit row together.
   *
   * ⚠ A FINDER KIND IS REFUSED, NOT CLOSED. The next tick would re-raise it, so a manual close
   * would be a lie that lasts one minute. `noteCloseableKinds` arrives as data (see
   * {@link CloseAdminAlertInput}).
   *
   * ⚠ A RESOLVED ROW IS NEVER REOPENED AND NEVER RE-CLOSED — `already_resolved` writes nothing,
   * which also makes a double-click idempotent rather than an error storm.
   *
   * ⚠ `not_found` DELIBERATELY CONFLATES missing and soft-deleted (the
   * `internalNotesRepository.softDelete` posture).
   *
   * ⚠⚠ THE NOTE IS NOT COPIED INTO `metadata`. It already lives in `resolution_note`;
   * duplicating free text into an APPEND-ONLY trail creates a second, unredactable copy (the
   * `internal-notes.ts` "the body is in neither" rule). The metadata records the SUBJECT the
   * alert was about, which is not recoverable from the alert row once it scrolls away.
   *
   * ⚠ `auditEventsRepository.record`'s executor is REQUIRED, no default — precisely so the
   * audit row commits with the change. `seq` is `generatedAlwaysAsIdentity()`; never name it.
   */
  async close(input: CloseAdminAlertInput): Promise<CloseAdminAlertOutcome> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: adminAlerts.id,
          kind: adminAlerts.kind,
          entityType: adminAlerts.entityType,
          entityId: adminAlerts.entityId,
          occurrences: adminAlerts.occurrences,
          resolvedAt: adminAlerts.resolvedAt,
        })
        .from(adminAlerts)
        .where(and(eq(adminAlerts.id, input.alertId), isNull(adminAlerts.deletedAt)))
        .for('update');

      if (row === undefined) {
        return { outcome: 'not_found' };
      }
      if (row.resolvedAt !== null) {
        return { outcome: 'already_resolved' };
      }
      if (!input.noteCloseableKinds.includes(row.kind)) {
        return { outcome: 'finder_kind', kind: row.kind };
      }

      const now = new Date();
      const [updated] = await tx
        .update(adminAlerts)
        .set({
          resolvedAt: now,
          resolvedByUserId: input.actorUserId,
          resolutionNote: input.note,
          updatedAt: now,
        })
        .where(eq(adminAlerts.id, row.id))
        .returning();

      if (updated === undefined) {
        throw new Error(`Failed to close admin alert: ${input.alertId}`);
      }

      const auditRow = await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'admin_alert.closed',
          entityType: 'admin_alert',
          entityId: row.id,
          metadata: {
            kind: row.kind,
            subjectEntityType: row.entityType,
            subjectEntityId: row.entityId,
            occurrences: row.occurrences,
          },
        },
        tx
      );

      return { outcome: 'closed', alert: updated, auditId: auditRow.id };
    });
  },
};

// ── The sweep heartbeat ────────────────────────────────────────────────────

/**
 * `adminSweepTicksRepository` (BAL-548 / R8) — the sweep's liveness row, read by the Home
 * page's "swept Ns ago" disclosure. See `schema/admin-alerts.ts` for why this is a table and
 * not a Redis key (`apps/web` has no Redis at all).
 */
export const adminSweepTicksRepository = {
  /**
   * Stamp one cadence's completed tick. Last-write-wins.
   *
   * ⚠ THE ARBITER IS THE PRIMARY KEY — TOTAL, NOT PARTIAL — so this upsert structurally cannot
   * hit the 42P10 class that {@link adminAlertsRepository.raise} has to restate a predicate to
   * avoid, and it needs no `targetWhere`. That is one of the three reasons `cadence` is the PK.
   *
   * ⚠ CALL IT AT THE END OF A TICK, EVEN WHEN A FINDER THREW. The row means "the sweep ran",
   * not "everything was healthy"; a sweep that stopped stamping is the one thing the page
   * cannot otherwise see. Finder failures raise `sweep.failed` instead.
   */
  async markTick(cadence: string, at: Date): Promise<void> {
    await db
      .insert(adminSweepTicks)
      .values({ cadence, lastTickAt: at })
      .onConflictDoUpdate({
        target: adminSweepTicks.cadence,
        set: { lastTickAt: at, updatedAt: new Date() },
      });
  },

  /** Every cadence's last tick, in a stable order. At most three rows, ever. */
  async listTicks(): Promise<AdminSweepTick[]> {
    return db.select().from(adminSweepTicks).orderBy(asc(adminSweepTicks.cadence));
  },
};
