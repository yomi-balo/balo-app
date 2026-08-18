import { eq, and, asc, isNull, lt } from 'drizzle-orm';
import { db } from '../client';
import {
  calendarConnections,
  calendarSubCalendars,
  availabilityCache,
  type CalendarConnection,
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
 * A method with no marking is genuinely unaffected (keyed by `connectionId`, `channelId`,
 * or not expert-scoped at all).
 *
 * ⚠ `@deprecated dies with BAL-396` marks the Cronofy-only surface. Those methods touch
 * columns (`access_token`, `refresh_token`, `token_expires_at`, `channel_id`) that an
 * Apiroc row leaves NULL, so an Apiroc connection is never a meaningful target for them
 * and making them provider-aware would be wasted work on code scheduled for deletion.
 */

// ── Input types ──────────────────────────────────────────────────

interface UpsertConnectionInput {
  expertProfileId: string;
  cronofySub: string;
  provider: string;
  providerEmail?: string | null;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: Date;
  status?: string;
}

interface UpdateTokensInput {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt: Date;
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
   * (c) LEGACY-SINGLE-CONNECTION-shaped — find a calendar connection by push notification
   * channel ID.
   *
   * ⚠⚠ CORRECTED IN THE BAL-467 FIX BRIEF (review WARNING, D6). Previously documented "✅
   * Unaffected by BAL-467 … already names exactly one row" — that is no longer accurate.
   * `channel_id` is written by `updateConnectionChannelId`, which is expert-scoped ONLY
   * (no provider term — see that method's docblock) and therefore fans out across ALL of
   * an expert's live connections. Once an expert holds two live connections (the
   * cardinality BAL-467 legalized), that write can leave the SAME `channel_id` on both
   * rows, and `findFirst` with no explicit order picks whichever Postgres happens to
   * return. `OLDEST_LIVE_FIRST` makes that deterministic rather than arbitrary — it does
   * NOT make it correct; a genuinely correct answer needs `channel_id` scoped per
   * connection, which is Cronofy-only surface scheduled to die with BAL-396, not extended
   * here.
   *
   * CRONOFY-ONLY.
   *
   * @deprecated dies with BAL-396 (Cronofy removal).
   */
  async findConnectionByChannelId(channelId: string): Promise<CalendarConnection | undefined> {
    return db.query.calendarConnections.findFirst({
      where: and(
        eq(calendarConnections.channelId, channelId),
        isNull(calendarConnections.deletedAt)
      ),
      orderBy: OLDEST_LIVE_FIRST,
    });
  },

  /**
   * (a) PROVIDER-SCOPED — upsert THIS expert's connection for THIS provider.
   *
   * ⚠⚠ THE ARBITER CHANGED IN BAL-467 AND IT HAD TO. It used to be
   * `target: [expertProfileId]`, matching the old `cal_conn_expert_profile_idx`. That
   * index is DROPPED by migration 0067, so leaving the arbiter alone would make the live
   * Cronofy connect path raise **42P10 — "there is no unique or exclusion constraint
   * matching the ON CONFLICT specification"** on its very first statement.
   *
   * ⚠⚠ `targetWhere` IS MANDATORY, NOT DECORATION. `cal_conn_expert_provider_idx` is
   * PARTIAL on `deleted_at IS NULL`. Postgres only selects a partial index as an
   * ON CONFLICT arbiter when the statement RESTATES its predicate; omit it and arbiter
   * inference fails AT PLAN TIME, so EVERY upsert raises 42P10 — including the first, on
   * an empty table. **Typecheck and the mocked unit test both stay green**, because the
   * unit test mocks the Drizzle client and only records the argument object. Only
   * `calendar.integration.test.ts`, on real Postgres, catches this. House precedent:
   * `repositories/reviews.ts`, `repositories/conversations.ts`.
   *
   * ⚠ `isNull()` renders `"deleted_at" is null` with NO bound parameter, so this is NOT
   * the `reference_pg_partial_index_arbiter_param_42p10` hazard (that one is a Drizzle
   * `eq()` emitting a `$1` Param, which can never match an index predicate). Do not
   * "fix" this into raw `sql` with inlined literals — there is no literal to inline.
   *
   * ⚠ RECONNECT AFTER DISCONNECT INSERTS A FRESH ROW. A soft-deleted row is invisible to
   * the partial index, so it cannot be the conflict target; the soft-deleted row is left
   * behind as history. That is correct and matches `company_members` / `agency_members`.
   * The `deletedAt: null` in `set` below is therefore only ever reached when a LIVE row
   * is re-upserted — it is a no-op safety belt, not the reconnect mechanism.
   *
   * @deprecated The INPUT SHAPE dies with BAL-396 — `cronofySub` and the three encrypted
   * token fields are Cronofy-only and an Apiroc row leaves all four NULL. BAL-396 owns
   * the Apiroc writer. The ARBITER above is permanent.
   */
  async upsertConnection(data: UpsertConnectionInput): Promise<CalendarConnection> {
    const [result] = await db
      .insert(calendarConnections)
      .values({
        expertProfileId: data.expertProfileId,
        cronofySub: data.cronofySub,
        provider: data.provider,
        providerEmail: data.providerEmail ?? null,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        tokenExpiresAt: data.tokenExpiresAt,
        status: data.status ?? 'connected',
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: [calendarConnections.expertProfileId, calendarConnections.provider],
        // ⚠⚠ See the warning above. Removing this line breaks EVERY upsert with 42P10.
        targetWhere: isNull(calendarConnections.deletedAt),
        set: {
          cronofySub: data.cronofySub,
          // `provider` is INTENTIONALLY absent: it is now half the arbiter, so the
          // conflicting row necessarily already holds this exact value.
          providerEmail: data.providerEmail ?? null,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          tokenExpiresAt: data.tokenExpiresAt,
          status: data.status ?? 'connected',
          updatedAt: new Date(),
          deletedAt: null,
        },
      })
      .returning();

    return result!;
  },

  /**
   * (a) PROVIDER-SCOPED — rewrites the Cronofy credential columns for ONE (expert, provider)
   * connection.
   *
   * ⚠⚠ CHANGED IN THE BAL-467 FIX BRIEF (security review CRITICAL, A2). This used to be
   * expert-scoped ONLY. The docblock argued an Apiroc row "is never a meaningful target"
   * for this write because it leaves `access_token`/`refresh_token`/`token_expires_at`
   * NULL — true, but that explains why the row SHOULD have no tokens; it does not PREVENT
   * the write. With a Cronofy row and an Apiroc row live for the same expert (post
   * BAL-467's per-provider cardinality), an expert-scoped-only `WHERE` can match the
   * Apiroc row too and overwrite its NULL token columns with Cronofy's — silently
   * corrupting a connection this code was never meant to touch. Not a cross-tenant break
   * (still expert-scoped), but a cross-PROVIDER one.
   *
   * CRONOFY-ONLY in practice — Balo holds no provider tokens for Apiroc (apiroc skill,
   * Constraint 1), so this write only ever has a meaningful target when `provider` is a
   * Cronofy provider. Its one caller, `services/cronofy/token-manager.ts`, always knows
   * which provider it is refreshing (it read the connection row first).
   *
   * @deprecated dies with BAL-396 (Cronofy removal).
   */
  async updateConnectionTokens(
    expertProfileId: string,
    provider: string,
    data: UpdateTokensInput
  ): Promise<void> {
    await db
      .update(calendarConnections)
      .set({
        accessToken: data.accessToken,
        ...(data.refreshToken !== undefined && { refreshToken: data.refreshToken }),
        tokenExpiresAt: data.tokenExpiresAt,
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
   * (b) FAN-OUT — sets `status` on ALL of this expert's live connections.
   *
   * ⚠ THIS IS A KNOWN IMPRECISION, NOT AN OVERSIGHT. One provider's `auth_error` should
   * not brand the other's connection as broken. Making it per-provider requires the
   * credential-status lifecycle that gives the value meaning (`ACTIVE | EXPIRED |
   * REVOKED`, plus the `status` → `credential_status` rename), and that is BAL-396 §2/§9
   * — which owns all seven live Cronofy call sites for this column. Today every caller
   * (`services/cronofy/{oauth,retry,token-manager}.ts`, `routes/calendar/webhook.ts`) is
   * a Cronofy path where the expert has exactly one connection, so the fan-out and the
   * per-provider write are the same write.
   */
  async updateConnectionStatus(expertProfileId: string, status: string): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(calendarConnections.expertProfileId, expertProfileId),
          isNull(calendarConnections.deletedAt)
        )
      );
  },

  /**
   * Update push notification channel ID.
   *
   * CRONOFY-ONLY — `channel_id` is a Cronofy push-channel handle. Apiroc delivers change
   * notifications via Svix-signed webhooks against a `calendar_subscriptions` row that
   * BAL-468 creates; it never writes this column. Not made provider-aware for the same
   * reason as `updateConnectionTokens`.
   *
   * @deprecated dies with BAL-396 (Cronofy removal).
   */
  async updateConnectionChannelId(expertProfileId: string, channelId: string): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ channelId, updatedAt: new Date() })
      .where(
        and(
          eq(calendarConnections.expertProfileId, expertProfileId),
          isNull(calendarConnections.deletedAt)
        )
      );
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
   * (c) LEGACY-SINGLE-CONNECTION, fanning out — sets `target_calendar_id` on ALL of this
   * expert's live connections.
   *
   * ⚠ THE AMENDMENT SAYS "`targetCalendarId` IS PER CONNECTION", so this fan-out is
   * WRONG under the new ruling — writing one provider's chosen calendar id onto the other
   * provider's row is meaningless (calendar ids are namespaced per provider account).
   * It is left as-is only because its two live callers (`routes/calendar/api.ts`,
   * `services/cronofy/oauth.ts`) are Cronofy paths with exactly one connection, where the
   * fan-out degenerates to the correct single write.
   *
   * NEW CODE MUST CALL `updateTargetCalendarIdForProvider`. BAL-396 retires this one.
   */
  async updateTargetCalendarId(expertProfileId: string, targetCalendarId: string): Promise<void> {
    await db
      .update(calendarConnections)
      .set({ targetCalendarId, updatedAt: new Date() })
      .where(
        and(
          eq(calendarConnections.expertProfileId, expertProfileId),
          isNull(calendarConnections.deletedAt)
        )
      );
  },

  /**
   * (a) PROVIDER-SCOPED — set the event-write target calendar for ONE connection.
   *
   * The amendment's "`targetCalendarId` is per connection" clause, expressed directly:
   * a calendar id is only meaningful inside the provider account that issued it.
   *
   * ⚠ INERT — no caller until BAL-396 wires event writes.
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
   * Find connected connections whose lastSyncedAt is before the threshold.
   *
   * ✅ Unaffected by BAL-467 — not expert-scoped. It now returns one row per (expert,
   * provider) rather than one per expert, which is exactly what the availability job
   * wants: each provider connection syncs on its own cadence.
   */
  async findStaleConnections(threshold: Date): Promise<CalendarConnection[]> {
    return db.query.calendarConnections.findMany({
      where: and(
        eq(calendarConnections.status, 'connected'),
        isNull(calendarConnections.deletedAt),
        lt(calendarConnections.lastSyncedAt, threshold)
      ),
    });
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
   * The CONNECTION row itself, however, carries `access_token` / `refresh_token`, so a
   * caller that forwards this value to a client MUST project columns explicitly
   * (`reference_drizzle_with_hydration_leaks_secrets`).
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
