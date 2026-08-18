import { eq, and, asc, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  calendarConnections,
  calendarSubCalendars,
  availabilityCache,
  type CalendarConnection,
  type CalendarCredentialStatus,
  type CalendarSubCalendar,
  type NewCalendarSubCalendar,
} from '../schema';

/**
 * ADR-1021, amendment 18 Aug 2026 (BAL-467), §1 — "A calendar connection is per
 * (expert, provider) … unique on `(expertId, provider)`. An expert may hold connections
 * to multiple providers at once; availability is the union of busy blocks across all of
 * the expert's connections; connect, disconnect, and reconnect are per-provider.
 * `targetCalendarId` is per connection."
 *
 * ⚠ EVERY METHOD BELOW THAT TAKES ONLY AN `expertProfileId` PREDATES THAT RULING. Before
 * BAL-467 the table was unique on `expert_profile_id` alone, so "the expert's connection"
 * was a well-defined phrase. It no longer is. Rather than rewrite the whole live Cronofy
 * call graph in a foundation slice (that is BAL-396), each such method is classified:
 *
 *   (a) PROVIDER-SCOPED — takes `provider`; correct under the new ruling.
 *   (b) FAN-OUT — deliberately acts on ALL of the expert's live connections; the docblock
 *       says so, so a reader is never surprised.
 *   (c) LEGACY-SINGLE-CONNECTION — returns ONE row, from an era that assumed there was
 *       only one. Given a deterministic `ORDER BY created_at, id` so the answer is the
 *       OLDEST live connection rather than whatever Postgres happens to return, plus a
 *       sibling in class (a) for callers that know which provider they mean.
 *
 * A method with no marking is genuinely unaffected (keyed by `connectionId` or not
 * expert-scoped at all).
 *
 * ⚠⚠ BAL-396 REMOVED THE CRONOFY WRITE SURFACE FROM THIS FILE. `upsertConnection`,
 * `updateConnectionTokens`, `updateConnectionChannelId`, `findConnectionByChannelId`,
 * `updateConnectionStatus` and the expert-wide `updateTargetCalendarId` are GONE — not
 * migrated. Every one of them either wrote a column Apiroc never populates
 * (`access_token`, `refresh_token`, `token_expires_at`, `channel_id`) or wrote the old
 * `status` vocabulary, and the two fan-outs among them were known imprecisions that a
 * per-provider world makes wrong rather than merely imprecise. Their replacements —
 * `upsertApirocConnection`, `setCredentialStatusForProvider`,
 * `updateTargetCalendarIdForProvider` — are ALL provider-scoped or connection-keyed.
 *
 * ⚠ THE CREDENTIAL-STATUS VOCABULARY IS TYPED, NOT STRINGLY. Every status argument below is
 * a `CalendarCredentialStatus`, so `'connected'` / `'auth_error'` are COMPILE ERRORS rather
 * than queries that quietly match zero rows (see the column's docblock in `schema/calendar.ts`).
 */

// ── Input types ──────────────────────────────────────────────────

/**
 * The Apiroc connect/reconnect payload. Note what is ABSENT: no tokens, no `cronofySub`, no
 * channel id. Balo stores a POINTER (`endUserAccountId`) and a status, and refreshes nothing
 * (apiroc skill, Constraint 1).
 */
export interface UpsertApirocConnectionInput {
  expertProfileId: string;
  provider: string;
  endUserAccountId: string;
  providerEmail?: string | null;
  /** Defaults to `'ACTIVE'`. The callback passes `'SYNC_PENDING'` when first provisioning fails. */
  credentialStatus?: CalendarCredentialStatus;
}

/**
 * One expert connection the free/busy read can act on, with the calendar ids that read
 * requires. Compound because `GetFreeBusyInput.calendarIds` is REQUIRED by the vendor SDK:
 * a connection without conflict-checked sub-calendars is not a readable target, and the
 * caller must be able to tell "nothing to check" from "cannot check".
 */
export interface BusyReadTarget {
  connectionId: string;
  provider: string;
  endUserAccountId: string;
  credentialStatus: CalendarCredentialStatus;
  /** Only sub-calendars with `conflict_check = true`. May be empty. */
  calendarIds: string[];
  /** False when the connection has NO sub-calendar rows at all (never provisioned). */
  provisioned: boolean;
}

interface ReplaceSubCalendarInput {
  calendarId: string;
  name: string;
  provider: string;
  profileName?: string | null;
  isPrimary: boolean;
  conflictCheck: boolean;
  color?: string | null;
}

// ── Repository ───────────────────────────────────────────────────

/**
 * The deterministic ordering for every LEGACY-SINGLE-CONNECTION read: oldest live
 * connection first. Without it, "the expert's connection" silently means "whichever row
 * the planner happened to return", and a caller's behaviour can change with no code
 * change at all — a vacuum, an index rebuild, or a different row order is enough.
 *
 * ⚠ `created_at` ALONE IS NOT A TOTAL ORDER. `defaultNow()` is Postgres `now()`, which is
 * TRANSACTION START TIME — two connections written in one transaction share a
 * byte-identical `created_at`. `id` breaks that tie. It is a random v4 UUID, so the
 * winner of a tie is arbitrary, but it is STABLE for a given database state, which is the
 * property that matters: the same query against the same rows always answers the same
 * way. In production the tie is unreachable anyway (each OAuth connect is its own
 * transaction); it is reachable in the integration harness, which holds each test in one
 * transaction — see `stampCreatedAt` in `calendar.integration.test.ts`.
 */
const OLDEST_LIVE_FIRST = [asc(calendarConnections.createdAt), asc(calendarConnections.id)];

export const calendarRepository = {
  /**
   * (c) LEGACY-SINGLE-CONNECTION — the OLDEST live connection for this expert, whichever
   * provider that happens to be.
   *
   * ⚠ Since BAL-467 an expert may hold one Google AND one Microsoft connection. This
   * method cannot express which one the caller means, so it answers deterministically
   * (oldest first) rather than arbitrarily. Its live callers — `routes/calendar/api.ts`,
   * `services/cronofy/{oauth,token-manager}.ts`, `lib/actions/expert-checklist.ts` — are
   * all Cronofy-era paths for which exactly one connection exists, so the ambiguity is
   * unreachable today.
   *
   * NEW CODE SHOULD CALL `findConnectionByExpertAndProvider` INSTEAD. A caller that
   * genuinely wants every provider wants `listConnectionsByExpertProfileId`.
   */
  async findConnectionByExpertProfileId(
    expertProfileId: string
  ): Promise<CalendarConnection | undefined> {
    return db.query.calendarConnections.findFirst({
      where: and(
        eq(calendarConnections.expertProfileId, expertProfileId),
        isNull(calendarConnections.deletedAt)
      ),
      orderBy: OLDEST_LIVE_FIRST,
    });
  },

  /**
   * (a) PROVIDER-SCOPED — the one live connection for this (expert, provider) pair.
   *
   * This is the read the ADR-1021 amendment sanctions: `cal_conn_expert_provider_idx` is
   * unique over exactly this pair among live rows, so the answer is unambiguous by
   * construction, not by ordering convention.
   *
   * ⚠ INERT — no caller until BAL-396 wires the Apiroc connect flow.
   */
  async findConnectionByExpertAndProvider(
    expertProfileId: string,
    provider: string
  ): Promise<CalendarConnection | undefined> {
    return db.query.calendarConnections.findFirst({
      where: and(
        eq(calendarConnections.expertProfileId, expertProfileId),
        eq(calendarConnections.provider, provider),
        isNull(calendarConnections.deletedAt)
      ),
    });
  },

  /**
   * (b) FAN-OUT — every live connection this expert holds, oldest first.
   *
   * The amendment's availability rule reads directly onto this method: "availability is
   * the union of busy blocks across ALL of the expert's connections". A free/busy caller
   * that reaches for `findConnectionByExpertProfileId` instead would silently ignore the
   * expert's second calendar and double-book them.
   *
   * ⚠ INERT — no caller until BAL-396 wires free/busy.
   */
  async listConnectionsByExpertProfileId(expertProfileId: string): Promise<CalendarConnection[]> {
    return db.query.calendarConnections.findMany({
      where: and(
        eq(calendarConnections.expertProfileId, expertProfileId),
        isNull(calendarConnections.deletedAt)
      ),
      orderBy: OLDEST_LIVE_FIRST,
    });
  },

  /**
   * Resolve live connections from an Apiroc End User Account id — the pointer model's
   * reverse lookup, and the reader that makes `cal_conn_end_user_account_idx` non-speculative.
   *
   * ⚠ RETURNS AN ARRAY, and that is deliberate. `cal_conn_end_user_account_idx` is
   * NON-unique on purpose (see the schema): nothing in ADR-1021 or the vendor docs
   * establishes that one End User Account maps to at most one Balo expert, and two
   * experts connecting the same Google account is routine in dev and seed data. A
   * singular signature here would encode that unevidenced cardinality at the read layer
   * and hand BAL-468's webhook handler an arbitrary row. If BAL-396 confirms the vendor
   * guarantees one-to-one, tighten the INDEX first, then narrow this.
   *
   * ⚠ INERT — no caller until BAL-468 handles webhooks.
   */
  async findConnectionsByEndUserAccountId(endUserAccountId: string): Promise<CalendarConnection[]> {
    return db.query.calendarConnections.findMany({
      where: and(
        eq(calendarConnections.endUserAccountId, endUserAccountId),
        isNull(calendarConnections.deletedAt)
      ),
      orderBy: OLDEST_LIVE_FIRST,
    });
  },

  /**
   * (a) PROVIDER-SCOPED — create or reconnect THIS expert's connection for THIS provider.
   * The ONLY writer that mints a `calendar_connections` row in an Apiroc world.
   *
   * ⚠⚠ THE ARBITER MUST NAME `provider` AND MUST RESTATE `targetWhere`.
   * `cal_conn_expert_provider_idx` is PARTIAL on `deleted_at IS NULL`, and Postgres only
   * selects a partial index as an ON CONFLICT arbiter when the statement REPEATS its
   * predicate. Omit either and **EVERY** upsert raises **42P10 — "there is no unique or
   * exclusion constraint matching the ON CONFLICT specification"** at PLAN time: on the
   * first statement, on an empty table, with `tsc` and the mocked unit test both green
   * (that test mocks the Drizzle client, so `onConflictDoUpdate` only records its argument
   * and never reaches a planner). Only `calendar.integration.test.ts` on real Postgres, and
   * `invariants/calendar-connection-cardinality.test.ts` on the source text, can catch it.
   *
   * ⚠ `isNull()` renders `"deleted_at" is null` with NO bound parameter, so this is NOT the
   * `reference_pg_partial_index_arbiter_param_42p10` hazard (that one is a Drizzle `eq()`
   * emitting a `$1` Param, which can never match an index predicate). Do not "fix" this
   * into raw `sql` with inlined literals — there is no literal to inline.
   *
   * ⚠ RECONNECT AFTER DISCONNECT INSERTS A FRESH ROW. A soft-deleted row is invisible to
   * the partial index, so it cannot be the conflict target; the soft-deleted row stays
   * behind as history. Matches `company_members` / `agency_members`. The `deletedAt: null`
   * in `set` is therefore only reached when a LIVE row is re-upserted — a no-op safety
   * belt, not the reconnect mechanism.
   *
   * ⚠ RECONNECT CLEARS THE NOTIFICATION MARKER. `reconnectNotifiedAt: null` in `set` is not
   * decoration: it is what lets a SECOND breakage notify the expert again. Leave it out and
   * an expert who reconnects, then breaks again, is never told.
   */
  async upsertApirocConnection(data: UpsertApirocConnectionInput): Promise<CalendarConnection> {
    const [result] = await db
      .insert(calendarConnections)
      .values({
        expertProfileId: data.expertProfileId,
        provider: data.provider,
        endUserAccountId: data.endUserAccountId,
        providerEmail: data.providerEmail ?? null,
        credentialStatus: data.credentialStatus ?? 'ACTIVE',
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: [calendarConnections.expertProfileId, calendarConnections.provider],
        // ⚠⚠ See the warning above. Removing this line breaks EVERY upsert with 42P10.
        targetWhere: isNull(calendarConnections.deletedAt),
        set: {
          // `provider` is INTENTIONALLY absent: it is half the arbiter, so the conflicting
          // row necessarily already holds this exact value.
          endUserAccountId: data.endUserAccountId,
          providerEmail: data.providerEmail ?? null,
          credentialStatus: data.credentialStatus ?? 'ACTIVE',
          reconnectNotifiedAt: null,
          credentialCheckedAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        },
      })
      .returning();

    return result!;
  },

  /**
   * (a) PROVIDER-SCOPED — replaces the deleted expert-wide `updateConnectionStatus` fan-out.
   *
   * ⚠ THE FAN-OUT WAS THE BUG. One provider's EXPIRED must never brand the other
   * provider's connection broken: that would show an expert "reconnect Microsoft" because
   * their Google token lapsed, and — via §9.4's fail-closed booking gate — would make them
   * unbookable on a calendar that is perfectly healthy.
   *
   * ⚠ WRITING `'ACTIVE'` ALSO CLEARS `reconnectNotifiedAt`. See {@link setCredentialStatus}.
   */
  async setCredentialStatusForProvider(
    expertProfileId: string,
    provider: string,
    credentialStatus: CalendarCredentialStatus
  ): Promise<void> {
    await db
      .update(calendarConnections)
      .set({
        credentialStatus,
        ...(credentialStatus === 'ACTIVE' ? { reconnectNotifiedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(calendarConnections.expertProfileId, expertProfileId),
          eq(calendarConnections.provider, provider),
          isNull(calendarConnections.deletedAt)
        )
      );
  },

  /**
   * Keyed by connection id — the health probe and the credential-status service already
   * hold the row, so neither needs to re-derive (expert, provider) from it.
   *
   * ⚠⚠ WRITING `'ACTIVE'` CLEARS `reconnectNotifiedAt`, IN THE SAME STATEMENT. That marker
   * means "the expert has already been told about THIS breakage"; a connection that is
   * healthy again has no current breakage, so leaving the marker set would silently
   * suppress the notification for the NEXT one. Keeping the clear here rather than at the
   * call site makes "ACTIVE ⇒ marker NULL" an invariant of this repository instead of a
   * step a caller can forget. Non-ACTIVE writes leave the marker exactly as it was — that
   * is what makes the notify-once check meaningful.
   */
  async setCredentialStatus(
    connectionId: string,
    credentialStatus: CalendarCredentialStatus
  ): Promise<void> {
    await db
      .update(calendarConnections)
      .set({
        credentialStatus,
        ...(credentialStatus === 'ACTIVE' ? { reconnectNotifiedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(calendarConnections.id, connectionId), isNull(calendarConnections.deletedAt)));
  },

  /**
   * Stamp a probe ATTEMPT against one connection — the probe's scan key, so a connection is
   * never re-selected twice in one interval.
   *
   * ⚠⚠ BAL-396 FIX ROUND — STAMPED ON A CLASSIFIED FAILURE TOO, NOT ONLY ON SUCCESS. The
   * original contract ("only a successful data call proves the credential works") is still
   * true of the credential STATUS, which this method never writes. But this column is also
   * `listConnectionsDueForHealthCheck`'s `ORDER BY ... ASC NULLS FIRST` scan key — and a
   * connection whose calls keep failing was never stamped, so it sorted FIRST forever and
   * starved every healthy connection out of the batch. Stamping on a CLASSIFIED failure too
   * ("we attempted this connection at T, whatever the answer") fixes the starvation without
   * touching credential status: the health probe still decides ACTIVE/EXPIRED/etc through
   * `applyCredentialFailure`/`setCredentialStatus`, never through this method.
   *
   * `checkedAt` is a parameter rather than `new Date()` so one sweep tick stamps ONE instant
   * across every connection it examined — the batch is the unit of evidence.
   */
  async markCredentialChecked(connectionId: string, checkedAt: Date): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ credentialCheckedAt: checkedAt, updatedAt: new Date() })
      .where(and(eq(calendarConnections.id, connectionId), isNull(calendarConnections.deletedAt)));
  },

  /**
   * Stamp the reconnect notification.
   *
   * ⚠ CALL THIS **AFTER** THE PUBLISH, NEVER BEFORE. House precedent: `markDunned()` on
   * `credit_receivables`. Stamping first turns a failed publish into permanent silence —
   * the sweep would see the marker on every later tick and never retry; stamping after
   * turns it into at-most-one-extra email, which is the survivable direction.
   */
  async markReconnectNotified(connectionId: string, notifiedAt: Date): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ reconnectNotifiedAt: notifiedAt, updatedAt: new Date() })
      .where(and(eq(calendarConnections.id, connectionId), isNull(calendarConnections.deletedAt)));
  },

  /**
   * Update lastSyncedAt for a connection (by connection ID).
   *
   * ✅ Unaffected by BAL-467 — already keyed by `connectionId`, so it names exactly one
   * row regardless of how many providers the expert has connected.
   */
  async updateLastSyncedAt(connectionId: string): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(calendarConnections.id, connectionId));
  },

  /**
   * (a) PROVIDER-SCOPED — set the event-write target calendar for ONE connection.
   *
   * The amendment's "`targetCalendarId` is per connection" clause, expressed directly:
   * a calendar id is only meaningful inside the provider account that issued it.
   *
   * ⚠ THE EXPERT-WIDE `updateTargetCalendarId` FAN-OUT IT REPLACED IS DELETED (BAL-396).
   * That one wrote one provider's chosen calendar id onto the other provider's row, where
   * it addresses nothing — harmless only while every expert had exactly one connection.
   */
  async updateTargetCalendarIdForProvider(
    expertProfileId: string,
    provider: string,
    targetCalendarId: string
  ): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ targetCalendarId, updatedAt: new Date() })
      .where(
        and(
          eq(calendarConnections.expertProfileId, expertProfileId),
          eq(calendarConnections.provider, provider),
          isNull(calendarConnections.deletedAt)
        )
      );
  },

  /**
   * (b) FAN-OUT — soft-deletes EVERY live connection this expert holds.
   *
   * Deliberate and already correct: this is "disconnect my calendar" in the whole-account
   * sense, and it is also the path `expert_profiles` teardown depends on. It was a
   * fan-out before BAL-467 too — the difference is only that the fan can now be wider
   * than one row.
   *
   * ⚠ Callers wanting "disconnect Google, keep Microsoft" — which the amendment makes a
   * real user action ("connect, disconnect, and reconnect are per-provider") — must call
   * `softDeleteConnectionForProvider`.
   */
  async softDeleteConnection(expertProfileId: string): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(calendarConnections.expertProfileId, expertProfileId),
          isNull(calendarConnections.deletedAt)
        )
      );
  },

  /**
   * (a) PROVIDER-SCOPED — disconnect ONE provider, leaving the expert's others live.
   *
   * The soft-deleted row stays behind as history and is invisible to
   * `cal_conn_expert_provider_idx` (PARTIAL on `deleted_at IS NULL`), so reconnecting the
   * same provider afterwards INSERTs a fresh row rather than failing 23505. That is the
   * whole reason the index is partial.
   *
   * ⚠ INERT — no caller until BAL-396 wires per-provider disconnect.
   */
  async softDeleteConnectionForProvider(expertProfileId: string, provider: string): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(calendarConnections.expertProfileId, expertProfileId),
          eq(calendarConnections.provider, provider),
          isNull(calendarConnections.deletedAt)
        )
      );
  },

  /**
   * Live, healthy connections not proven since the threshold — the 15-minute
   * availability-staleness cron's candidate list.
   *
   * ✅ Unaffected by BAL-467 — not expert-scoped. It returns one row per (expert, provider),
   * which is exactly what the availability job wants: each provider connection syncs on its
   * own cadence.
   *
   * ⚠⚠ THE STATUS TERM IS WHY `credential_status` IS A TYPED COLUMN. This filter used to
   * read `eq(status, 'connected')`. Renaming the column WITHOUT typing it would have left
   * this literal compiling against the new vocabulary and matching ZERO ROWS FOREVER — the
   * cron would run every 15 minutes, find nothing, and report nothing wrong, so no
   * connected expert's availability would ever be resynced again. With
   * `.$type<CalendarCredentialStatus>()` the stale literal is a `tsc` error instead.
   * `calendar.integration.test.ts` pins the behaviour on real Postgres as well.
   *
   * ⚠⚠ BAL-396 FIX ROUND — REPOINTED FROM `last_synced_at` TO `credential_checked_at`, AND
   * THIS IS NOT A COSMETIC RENAME. `last_synced_at`'s ONLY production writer was
   * `updateLastSyncedAt`, called solely from the Cronofy-era webhook route BAL-396 DELETED.
   * With no writer left, every row's `last_synced_at` is NULL forever, `lt(NULL, threshold)`
   * is NULL (not true), and the old query returned `[]` on every tick — a PERMANENT no-op,
   * not the "pre-existing behaviour left untouched" a stale comment here used to claim.
   * `credential_checked_at` DOES have a live writer (`markCredentialChecked`, stamped by the
   * health probe on every attempt — see that method's docblock — and by
   * `upsertApirocConnection` on connect/reconnect), so this is a real signal again: it is
   * the platform's ONLY time-based availability-rebuild trigger until BAL-468 ships the
   * webhook.
   *
   * ⚠ `or(isNull(...), lt(...))` — a NEVER-CHECKED connection (fresh INSERT; `set` only
   * stamps `credential_checked_at` on the UPDATE arm — see `upsertApirocConnection`) MUST
   * match immediately rather than waiting out one full threshold window unrebuilt. Pinned by
   * `calendar.integration.test.ts` (a never-checked connection returns from this query).
   */
  async findStaleConnections(threshold: Date): Promise<CalendarConnection[]> {
    return db.query.calendarConnections.findMany({
      where: and(
        eq(calendarConnections.credentialStatus, 'ACTIVE'),
        isNull(calendarConnections.deletedAt),
        or(
          isNull(calendarConnections.credentialCheckedAt),
          lt(calendarConnections.credentialCheckedAt, threshold)
        )
      ),
    });
  },

  /**
   * The health probe's candidate scan: live connections whose credential has not been
   * PROVEN since `checkedBefore`. A NULL `credential_checked_at` counts as never-checked and
   * therefore sorts FIRST.
   *
   * ⚠ RETURNS NON-ACTIVE CONNECTIONS TOO, DELIBERATELY. The probe is also the healer: a
   * `SYNC_PENDING` connection whose probe call succeeds gets re-provisioned and flipped to
   * `ACTIVE`, and an `EXPIRED`/`REVOKED` one whose call now succeeds was reconnected out of
   * band. Filtering to `ACTIVE` here would make every broken connection permanently broken.
   *
   * ⚠ `limit` IS A BATCH BOUND THE CALLER MUST WARN ABOUT WHEN IT FILLS (no silent caps —
   * precedent `MEETING_LIFECYCLE_BATCH_LIMIT`). Coverage, not burst, is what stretches as
   * experts grow: a filled batch means some connections waited a tick, which must be
   * visible in logs rather than inferred.
   *
   * ⚠ ORDERING IS `NULLS FIRST`, WHICH `cal_conn_credential_check_idx` DOES NOT ITSELF
   * PROVIDE (it is a plain ASC btree, so Postgres sorts). The index is here for the
   * PREDICATE — live rows, by check time — and the batch is ≤ a few hundred rows, so the
   * sort is not the cost that matters. `id` breaks ties so a tick's batch is stable rather
   * than planner-dependent (same reasoning as `OLDEST_LIVE_FIRST`).
   *
   * ⚠ NO `end_user_account_id IS NOT NULL` FILTER — REMOVED IN THE BAL-396 FIX ROUND.
   * Migration 0069 made the column `NOT NULL`, so every live row already carries a pointer;
   * the predicate was vacuous (always true) rather than protective, and Postgres enforces it
   * at the constraint level regardless of what this query asks for.
   */
  async listConnectionsDueForHealthCheck(
    checkedBefore: Date,
    limit: number
  ): Promise<CalendarConnection[]> {
    return db.query.calendarConnections.findMany({
      where: and(
        isNull(calendarConnections.deletedAt),
        or(
          isNull(calendarConnections.credentialCheckedAt),
          lt(calendarConnections.credentialCheckedAt, checkedBefore)
        )
      ),
      orderBy: [
        sql`${calendarConnections.credentialCheckedAt} asc nulls first`,
        asc(calendarConnections.id),
      ],
      limit,
    });
  },

  /**
   * Every live connection this expert holds, with the conflict-checked calendar ids the
   * free/busy read needs. ONE round trip (the sub-calendars come back through the declared
   * relation, not a second query).
   *
   * ⚠⚠ RETURNS NON-ACTIVE CONNECTIONS TOO, DELIBERATELY — AND OMITTING THEM WOULD BE A
   * SAFETY BUG, NOT A TIDY-UP. An unreadable connection (`SYNC_PENDING`, `EXPIRED`,
   * `REVOKED`, or provisioned with zero sub-calendar rows) must make the booking gate fail
   * CLOSED. Filtering them out here would hand the gate an empty list, which it reads as
   * "this expert has no external calendar" — failing OPEN, and double-booking an expert in
   * front of a paying client. The caller distinguishes "nothing to check" from "cannot
   * check"; this method must give it the material to do so.
   *
   * ⚠ NO `end_user_account_id IS NOT NULL` FILTER — REMOVED IN THE BAL-396 FIX ROUND.
   * Migration 0069 made the column `NOT NULL`, so every live row already carries a pointer;
   * a Cronofy-era row without one cannot exist any more (the "rollout seam" this predicate
   * used to describe closed when 0069 landed). `endUserAccountId` on the returned row is
   * therefore `string`, not `string | null` — no runtime guard is needed to narrow it.
   *
   * ⚠ No token or PII column is projected, so the `with:` hydration cannot leak one
   * (`reference_drizzle_with_hydration_leaks_secrets`); the return type is a purpose-built
   * projection rather than the row.
   */
  async listBusyReadTargets(expertProfileId: string): Promise<BusyReadTarget[]> {
    const rows = await db.query.calendarConnections.findMany({
      where: and(
        eq(calendarConnections.expertProfileId, expertProfileId),
        isNull(calendarConnections.deletedAt)
      ),
      columns: {
        id: true,
        provider: true,
        endUserAccountId: true,
        credentialStatus: true,
      },
      with: {
        subCalendars: { columns: { calendarId: true, conflictCheck: true } },
      },
      orderBy: OLDEST_LIVE_FIRST,
    });

    return rows.map((row) => ({
      connectionId: row.id,
      provider: row.provider,
      endUserAccountId: row.endUserAccountId,
      credentialStatus: row.credentialStatus,
      calendarIds: row.subCalendars.filter((sub) => sub.conflictCheck).map((sub) => sub.calendarId),
      provisioned: row.subCalendars.length > 0,
    }));
  },

  // ── Sub-calendar methods ────────────────────────────────────────

  /** Find all sub-calendars for a connection */
  async findSubCalendarsByConnectionId(connectionId: string): Promise<CalendarSubCalendar[]> {
    return db.query.calendarSubCalendars.findMany({
      where: eq(calendarSubCalendars.connectionId, connectionId),
    });
  },

  /** Replace all sub-calendars for a connection (delete + re-insert in tx) */
  async replaceSubCalendars(
    connectionId: string,
    calendars: ReplaceSubCalendarInput[]
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .delete(calendarSubCalendars)
        .where(eq(calendarSubCalendars.connectionId, connectionId));

      if (calendars.length > 0) {
        await tx.insert(calendarSubCalendars).values(
          calendars.map(
            (cal): NewCalendarSubCalendar => ({
              connectionId,
              calendarId: cal.calendarId,
              name: cal.name,
              provider: cal.provider,
              profileName: cal.profileName ?? null,
              isPrimary: cal.isPrimary,
              conflictCheck: cal.conflictCheck,
              color: cal.color ?? null,
            })
          )
        );
      }
    });
  },

  /** Update conflict-check toggle for a specific sub-calendar */
  async updateConflictCheck(
    connectionId: string,
    calendarId: string,
    conflictCheck: boolean
  ): Promise<void> {
    await db
      .update(calendarSubCalendars)
      .set({ conflictCheck, updatedAt: new Date() })
      .where(
        and(
          eq(calendarSubCalendars.connectionId, connectionId),
          eq(calendarSubCalendars.calendarId, calendarId)
        )
      );
  },

  /** Find a specific sub-calendar by calendarId within a connection */
  async findSubCalendarByCalendarId(
    connectionId: string,
    calendarId: string
  ): Promise<CalendarSubCalendar | undefined> {
    return db.query.calendarSubCalendars.findFirst({
      where: and(
        eq(calendarSubCalendars.connectionId, connectionId),
        eq(calendarSubCalendars.calendarId, calendarId)
      ),
    });
  },

  /** Delete all sub-calendars for a connection */
  async deleteSubCalendarsByConnectionId(connectionId: string): Promise<void> {
    await db
      .delete(calendarSubCalendars)
      .where(eq(calendarSubCalendars.connectionId, connectionId));
  },

  // ── Availability cache methods ─────────────────────────────────

  /** Upsert availability cache for an expert */
  async upsertAvailabilityCache(
    expertProfileId: string,
    earliestAvailableAt: Date | null
  ): Promise<void> {
    await db
      .insert(availabilityCache)
      .values({
        expertProfileId,
        earliestAvailableAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [availabilityCache.expertProfileId],
        set: {
          earliestAvailableAt,
          updatedAt: new Date(),
        },
      });
  },

  /** Clear availability cache for an expert (set earliestAvailableAt to null) */
  async clearAvailabilityCache(expertProfileId: string): Promise<void> {
    await db
      .insert(availabilityCache)
      .values({
        expertProfileId,
        earliestAvailableAt: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [availabilityCache.expertProfileId],
        set: {
          earliestAvailableAt: null,
          updatedAt: new Date(),
        },
      });
  },

  // ── Compound queries ───────────────────────────────────────────

  /**
   * (c) LEGACY-SINGLE-CONNECTION — the OLDEST live connection with its sub-calendars.
   *
   * Same ambiguity and same deterministic ordering as `findConnectionByExpertProfileId`;
   * see that docblock. Both live callers are in `routes/calendar/api.ts` (Cronofy).
   *
   * ⚠ The `with: { subCalendars: true }` hydration is safe to expose: `calendar_sub_calendars`
   * carries no tokens and no PII beyond a calendar display name the expert already sees.
   * The CONNECTION row itself, however, still carries `access_token` / `refresh_token` until
   * migration 0069 drops them, so a caller that forwards this value to a client MUST project
   * columns explicitly (`reference_drizzle_with_hydration_leaks_secrets`). Even after 0069 the
   * rule holds for `end_user_account_id` — a vendor pointer is not a client-facing field.
   */
  async findConnectionWithSubCalendars(
    expertProfileId: string
  ): Promise<(CalendarConnection & { subCalendars: CalendarSubCalendar[] }) | undefined> {
    return db.query.calendarConnections.findFirst({
      where: and(
        eq(calendarConnections.expertProfileId, expertProfileId),
        isNull(calendarConnections.deletedAt)
      ),
      orderBy: OLDEST_LIVE_FIRST,
      with: { subCalendars: true },
    });
  },
};
