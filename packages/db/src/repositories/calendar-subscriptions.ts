import { and, asc, desc, eq, exists, inArray, isNull, lt, notExists, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  calendarConnections,
  calendarSubCalendars,
  calendarSubscriptions,
  type CalendarSubscription,
} from '../schema';

/**
 * The create payload for one Apiroc webhook subscription.
 *
 * ⚠⚠ `id` IS MINTED BY THE CALLER, BEFORE THE VENDOR CALL, and is deliberately NOT defaulted
 * here. The webhook URL registered at the vendor must CONTAIN Balo's row id
 * (`${base}/webhooks/apiroc/calendar/${id}`), but the row cannot be inserted until the vendor
 * returns `webhookSubscriptionId` and `endpointSecret` — both `NOT NULL`. The only ordering
 * that closes that loop is: mint the uuid → build the URL → create at the vendor → insert
 * here. Letting the column default would make the URL name a row that does not exist.
 *
 * (If the vendor create succeeds and this insert then fails, the result is a vendor
 * subscription whose url names no live row — which the reconciler's ORPHAN rule deletes on
 * the next pass. That self-healing property is why the orphan rule exists at all.)
 */
export interface InsertSubscriptionInput {
  /** ⚠ MINTED BY THE CALLER, BEFORE the vendor call. Not defaulted — see above. */
  id: string;
  connectionId: string;
  calendarId: string;
  /**
   * ⚠ The vendor list model's `id` field — NOT its field literally named `subscriptionId`
   * (that one is the provider channel uuid, and passing it to `delete` is a silent no-op).
   */
  webhookSubscriptionId: string;
  /**
   * ⚠ ALREADY ENCRYPTED. This repository never encrypts and never decrypts — `apps/api` owns
   * the cipher (`lib/calendar-encryption.ts`, its own AES-256-GCM key). Handing it a
   * plaintext secret stores a plaintext secret, silently.
   */
  endpointSecret: string;
  webhookUrl: string;
}

/** One live ACTIVE connection that currently has no live subscription at all. */
export interface ActiveConnectionWithoutSubscription {
  connectionId: string;
  expertProfileId: string;
}

/**
 * `calendarSubscriptionsRepository` (BAL-468) — the ONLY access path to
 * `calendar_subscriptions`.
 *
 * ⚠⚠ THERE IS NO UPSERT HERE, DELIBERATELY (plan ruling #6). Every write below is a plain
 * INSERT, a keyed UPDATE, or a keyed soft delete. No method issues an `ON CONFLICT`, so the
 * partial-arbiter 42P10 hazard that forces `calendarRepository.upsertApirocConnection` to
 * restate `targetWhere` CANNOT ARISE IN THIS FILE. Do not "add the missing targetWhere" to a
 * statement that has no conflict clause, and do not convert `insertSubscription` into an
 * upsert to "make it idempotent" — its idempotency comes from the reconciler's plan, and an
 * upsert on `webhook_subscription_id` would silently rewrite a live registration's row.
 *
 * ⚠ EVERY READ FILTERS `deleted_at IS NULL`. Soft-deleted rows are torn-down or superseded
 * registrations; a read that returned one would hand the webhook a secret for a subscription
 * the vendor no longer has, or hand the monitor an "expiry" that is really a teardown.
 *
 * ⚠ `endpoint_secret` COMES BACK ON EVERY `select()` here (these are `$inferSelect` rows).
 * The webhook is its only legitimate reader — it decrypts, verifies, discards. Never log a
 * row from this repository whole, never put one in an analytics property, never return one
 * across an HTTP boundary.
 */
export const calendarSubscriptionsRepository = {
  /**
   * The webhook's ONE indexed read: primary key + `deleted_at IS NULL`.
   *
   * A soft-deleted row must read as ABSENT, not as "found but dead" — the handler's 404
   * decision keys on this, and a torn-down subscription that still resolved would keep
   * accepting deliveries for a registration Balo has already abandoned.
   */
  async findLiveById(id: string): Promise<CalendarSubscription | undefined> {
    const [row] = await db
      .select()
      .from(calendarSubscriptions)
      .where(and(eq(calendarSubscriptions.id, id), isNull(calendarSubscriptions.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * Every live row for a connection, NEWEST FIRST.
   *
   * ⚠⚠ THE ORDERING IS THE CANONICITY RULE, NOT COSMETICS. Because there is no unique on
   * `(connection_id, calendar_id)` (ruling #5 — create-then-delete renewal makes a live
   * overlap the legitimate steady state), "the" subscription for a calendar is DERIVED: the
   * newest live row wins, and every older live sibling is a `superseded` delete target on the
   * next reconciliation pass. `buildSubscriptionPlan` consumes this list in exactly this
   * order and groups by `calendarId`, taking the FIRST as canonical. Reverse it, or drop the
   * tiebreak, and renewal starts superseding the row it just created.
   *
   * ⚠ `created_at` ALONE IS NOT A TOTAL ORDER — `defaultNow()` is Postgres `now()`, i.e.
   * TRANSACTION START TIME, so two rows written in one transaction share a byte-identical
   * value. `id desc` breaks that tie: arbitrary, but STABLE for a given database state, which
   * is the property canonicity actually needs. (Reachable in the integration harness, which
   * holds each test in one transaction; in production each create is its own transaction.)
   */
  async listLiveByConnectionId(connectionId: string): Promise<CalendarSubscription[]> {
    return db
      .select()
      .from(calendarSubscriptions)
      .where(
        and(
          eq(calendarSubscriptions.connectionId, connectionId),
          isNull(calendarSubscriptions.deletedAt)
        )
      )
      .orderBy(desc(calendarSubscriptions.createdAt), desc(calendarSubscriptions.id));
  },

  /**
   * Live rows by id, ACROSS ALL CONNECTIONS.
   *
   * ⚠⚠ USED ONLY BY THE ORPHAN RULE, AND ITS GLOBAL SCOPE IS THE WHOLE POINT.
   * `cal_conn_end_user_account_idx` is deliberately NON-unique — two Balo experts connecting
   * the same Google account is routine in dev and seed data, and a revoke → reconnect cycle
   * returns the SAME `endUserAccountId` — so `calendarSubscriptions.list(eua)` returns
   * subscriptions belonging to OTHER Balo connections. A per-connection orphan check would
   * therefore delete a healthy sibling expert's subscription on every sweep, silently killing
   * their change push. Scoping this read to one connection re-introduces exactly that bug.
   *
   * Empty input short-circuits to `[]` with NO query: `inArray(col, [])` is a degenerate
   * predicate and is not worth a round trip.
   */
  async listLiveByIds(ids: readonly string[]): Promise<CalendarSubscription[]> {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(calendarSubscriptions)
      .where(
        and(inArray(calendarSubscriptions.id, [...ids]), isNull(calendarSubscriptions.deletedAt))
      );
  },

  /**
   * Plain INSERT — no `ON CONFLICT` (see the repository docblock).
   *
   * A 23505 here is not a race to swallow: it means the vendor handed back a
   * `webhookSubscriptionId` that is already live in Balo, which is a real anomaly the caller
   * should surface rather than paper over.
   */
  async insertSubscription(input: InsertSubscriptionInput): Promise<CalendarSubscription> {
    const [row] = await db
      .insert(calendarSubscriptions)
      .values({
        id: input.id,
        connectionId: input.connectionId,
        calendarId: input.calendarId,
        webhookSubscriptionId: input.webhookSubscriptionId,
        endpointSecret: input.endpointSecret,
        webhookUrl: input.webhookUrl,
      })
      .returning();
    return row!;
  },

  /**
   * The reconciler's verification-pass stamp: what the VENDOR says about this row, and when
   * we last heard it.
   *
   * `expiration: null` means "the vendor reports no expiry for this subscription" — NOT "we
   * do not know". The don't-know state is the column still being NULL with
   * `expiration_synced_at` also NULL, which is what the monitor's `unconfirmed` arm watches.
   * That is why both values are written together and why a row the vendor did NOT list is
   * left entirely untouched by the caller rather than stamped with a null.
   */
  async stampVendorState(id: string, expiration: Date | null, syncedAt: Date): Promise<void> {
    await db
      .update(calendarSubscriptions)
      .set({ expiration, expirationSyncedAt: syncedAt, updatedAt: new Date() })
      .where(and(eq(calendarSubscriptions.id, id), isNull(calendarSubscriptions.deletedAt)));
  },

  /**
   * Verified-delivery liveness stamp — the WEBHOOK is the only caller, and only AFTER
   * signature verification.
   *
   * Liveness evidence no expiry check can produce: a subscription that has never delivered
   * while its sibling calendars have is a silent provider-channel death whose vendor record
   * still looks perfectly healthy. Read-only ops signal in this PR — nothing branches on it.
   */
  async stampDelivery(id: string, at: Date): Promise<void> {
    await db
      .update(calendarSubscriptions)
      .set({ lastDeliveryAt: at, updatedAt: new Date() })
      .where(and(eq(calendarSubscriptions.id, id), isNull(calendarSubscriptions.deletedAt)));
  },

  /**
   * Soft-delete ONE row, by id.
   *
   * ⚠ CALL THIS ONLY AFTER THE VENDOR DELETE SUCCEEDS. A failed vendor delete must LEAVE THE
   * ROW LIVE, for two reasons: (a) the still-live vendor subscription keeps delivering, and a
   * live row means its URL still resolves and verifies instead of 404-ing into Svix's
   * retry-then-disable path; (b) the next reconciliation pass sees it as `superseded` and
   * retries the delete. Soft-deleting on a failed delete manufactures exactly the "stale
   * subscription delivering to a dead URL" state the lifecycle exists to prevent.
   */
  async softDeleteById(id: string): Promise<void> {
    const now = new Date();
    await db
      .update(calendarSubscriptions)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(calendarSubscriptions.id, id), isNull(calendarSubscriptions.deletedAt)));
  },

  /**
   * Teardown on disconnect: every live row for the connection at once.
   *
   * Scoped to ONE connection, never to the expert — disconnect is per-provider (ADR-1021
   * amendment §1), and an expert-wide sweep would tear down the calendars of a provider they
   * did not disconnect.
   */
  async softDeleteByConnectionId(connectionId: string): Promise<void> {
    const now = new Date();
    await db
      .update(calendarSubscriptions)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(calendarSubscriptions.connectionId, connectionId),
          isNull(calendarSubscriptions.deletedAt)
        )
      );
  },

  /**
   * MONITOR ARM 1 — renewal is in arrears. Live rows whose vendor-reported `expiration` is
   * KNOWN and already inside the alert window.
   *
   * `expiration IS NOT NULL` is explicit rather than incidental: a NULL expiration is arm 2's
   * question ("the vendor never confirmed this row"), and folding the two together would make
   * a row created 90 seconds ago masquerade as an expiry.
   *
   * ⚠ `limit` IS A BATCH BOUND THE CALLER MUST WARN ABOUT WHEN IT FILLS. No silent caps —
   * house precedent `CALENDAR_HEALTH_PROBE_BATCH_LIMIT` / `MEETING_LIFECYCLE_BATCH_LIMIT`. A
   * saturated batch on an alerting query is itself the alarming reading.
   */
  async listExpiringBefore(threshold: Date, limit: number): Promise<CalendarSubscription[]> {
    return db
      .select()
      .from(calendarSubscriptions)
      .where(
        and(
          isNull(calendarSubscriptions.deletedAt),
          sql`${calendarSubscriptions.expiration} IS NOT NULL`,
          lt(calendarSubscriptions.expiration, threshold)
        )
      )
      .orderBy(asc(calendarSubscriptions.expiration), asc(calendarSubscriptions.id))
      .limit(limit);
  },

  /**
   * MONITOR ARM 2 — rows the VENDOR HAS NEVER CONFIRMED. Live rows the reconciler's `list` pass
   * has never stamped, created before the grace cutoff.
   *
   * Deliberately separate from arm 1 (see above). The `createdBefore` grace is what keeps a
   * row created seconds ago — whose verification pass simply has not run yet — out of the
   * alert, so a firing arm 2 means the reconciler's `list` pass has genuinely not succeeded
   * for this row.
   *
   * ⚠⚠ "UNCONFIRMED" IS `expiration IS NULL` **AND** `expiration_synced_at IS NULL` — BOTH
   * COLUMNS, AND THE SECOND ONE IS THE LOAD-BEARING HALF (PR #223 review).
   *
   * `stampVendorState`'s docblock already draws this distinction and this query used to
   * contradict it: `expiration: null` means "the vendor reports NO EXPIRY for this
   * subscription", which is a real, confirmed answer — the don't-know state is the column
   * being null with `expiration_synced_at` ALSO null, i.e. nobody has looked. Three other
   * places already treat vendor-reports-no-expiry as a real state (`parseVendorExpiration`,
   * the `expiration` column doc, and `canonicalRenewalReason`, which declines to plan a
   * full-expiration renewal for such a row).
   *
   * Checking only `expiration` therefore alerted FOREVER on any subscription Apiroc returns
   * without an expiry: `stampVendorState` writes `expiration = null, expiration_synced_at =
   * now`, the row is fully confirmed, and arm 2 kept flagging it every day with the self-heal
   * unable to change anything. Whether Apiroc ever returns such a row is still open on
   * BAL-455 — which is exactly why the query must encode the documented semantics rather than
   * assume the vendor never does it.
   *
   * ⚠ Same no-silent-caps contract on `limit` as arm 1.
   */
  async listUnconfirmedBefore(createdBefore: Date, limit: number): Promise<CalendarSubscription[]> {
    return db
      .select()
      .from(calendarSubscriptions)
      .where(
        and(
          isNull(calendarSubscriptions.deletedAt),
          isNull(calendarSubscriptions.expiration),
          isNull(calendarSubscriptions.expirationSyncedAt),
          lt(calendarSubscriptions.createdAt, createdBefore)
        )
      )
      .orderBy(asc(calendarSubscriptions.createdAt), asc(calendarSubscriptions.id))
      .limit(limit);
  },

  /**
   * MONITOR ARM 3 — THE INVERSE ALERT. Live `ACTIVE` connections that SHOULD hold at least one
   * subscription and hold none.
   *
   * ⚠⚠ THIS IS THE ONE QUESTION NO PER-SUBSCRIPTION CHECK CAN ASK. A silent platform-wide
   * expiry (or a reconciler that quietly stopped running) leaves behind connections with no
   * rows at all — arms 1 and 2 scan `calendar_subscriptions`, so they see NOTHING and report
   * a clean bill of health while every expert's change push is dead.
   *
   * ⚠⚠ IT ALERTS ON **DESIRED-BUT-ABSENT**, NOT ON **ABSENT** — AND THAT DISTINCTION IS THE
   * WHOLE CORRECTNESS OF THIS ARM (PR #223 review).
   *
   * The reconciler's DESIRED set is `subCalendars.filter((c) => c.conflictCheck)`. A connection
   * with no conflict-checked calendar therefore SHOULD have zero subscriptions — the reconciler
   * correctly creates nothing for it. Alerting on bare absence would page about that connection
   * every single day, forever, with the self-heal structurally unable to fix it: exactly the
   * alert-fatigue failure mode the whole gating design exists to avoid, just reached in the
   * ENABLED steady state instead of on the revert path.
   *
   * ⚠ AND THE STATE IS REACHABLE, NOT THEORETICAL. `provisionConnection` floors `conflictCheck`
   * on the PRIMARY calendar (`cal.isPrimary || existing`) — but if the provider reports NO
   * writable calendar as primary, `writable.find((cal) => cal.isPrimary)` is `undefined`,
   * `targetCalendarId` stays null, and the connection is STILL persisted `ACTIVE`. That yields
   * a legitimately-zero-conflict-check ACTIVE connection. Nothing in the schema or in
   * `apiroc-connection.ts` guarantees "ACTIVE ⇒ ≥1 conflict-check calendar", so this query must
   * not assume it.
   *
   * Two cross-table reads (`EXISTS` over the desired set, `NOT EXISTS` over subscriptions),
   * owned by THIS repository rather than `calendarRepository`, because the question is about
   * subscription ABSENCE.
   *
   * ⚠ THE CALLER MUST GATE THIS ARM ON THE FEATURE BEING CONFIGURED. Before the on-switch is
   * thrown, EVERY ACTIVE connection legitimately has zero subscriptions, and an ungated arm 3
   * would alert on the entire fleet on day one.
   *
   * ⚠ Same no-silent-caps contract on `limit` as arms 1 and 2.
   */
  async listActiveConnectionsWithoutSubscription(
    limit: number
  ): Promise<ActiveConnectionWithoutSubscription[]> {
    return db
      .select({
        connectionId: calendarConnections.id,
        expertProfileId: calendarConnections.expertProfileId,
      })
      .from(calendarConnections)
      .where(
        and(
          isNull(calendarConnections.deletedAt),
          eq(calendarConnections.credentialStatus, 'ACTIVE'),
          // The DESIRED set — mirrors the reconciler's `subCalendars.filter(c => c.conflictCheck)`.
          // Without this arm, a connection that legitimately wants no subscriptions pages daily.
          exists(
            db
              .select({ one: sql`1` })
              .from(calendarSubCalendars)
              .where(
                and(
                  eq(calendarSubCalendars.connectionId, calendarConnections.id),
                  eq(calendarSubCalendars.conflictCheck, true)
                )
              )
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(calendarSubscriptions)
              .where(
                and(
                  eq(calendarSubscriptions.connectionId, calendarConnections.id),
                  isNull(calendarSubscriptions.deletedAt)
                )
              )
          )
        )
      )
      .orderBy(asc(calendarConnections.createdAt), asc(calendarConnections.id))
      .limit(limit);
  },
};
