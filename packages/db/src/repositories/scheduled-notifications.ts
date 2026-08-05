import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../client';
import {
  scheduledNotifications,
  type ScheduledNotification,
  type ScheduledNotificationMode,
  type ScheduledNotificationPayload,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/**
 * THE ARBITER PREDICATE — a byte-for-byte restatement of
 * `scheduled_notification_pending_key_idx`'s `WHERE` clause.
 *
 * ⚠ TWO THINGS ARE LOAD-BEARING HERE AND BOTH ARE EASY TO BREAK:
 *
 *  1. THE PREDICATE MUST BE RESTATED AT ALL. Postgres cannot infer a PARTIAL unique index
 *     as the `ON CONFLICT` arbiter unless the statement's `WHERE` implies the index's own
 *     predicate. Omit it and every upsert fails `42P10` ("no unique or exclusion constraint
 *     matching the ON CONFLICT specification"). Same requirement the
 *     `conversation_read_states` upsert meets.
 *
 *  2. THE ENUM LITERAL MUST BE INLINED, NOT PARAMETERISED. Written as
 *     `eq(scheduledNotifications.status, 'pending')`, Drizzle emits a bind parameter, and
 *     Postgres's predicate-implication prover compares expression trees — a `Param` node
 *     never proves equality against the index predicate's `Const`. The upsert would then
 *     fail `42P10` even though the text "looks" right. Hence raw `sql` with the literal.
 *     `deleted_at IS NULL` has no such hazard, but is written here too so the whole
 *     predicate lives in ONE place and can be diffed against the migration by eye.
 */
const PENDING_ARBITER = sql`${scheduledNotifications.status} = 'pending' AND ${scheduledNotifications.deletedAt} IS NULL`;

/**
 * "This claim is STALE" — evaluated end-to-end on the DATABASE clock.
 *
 * ⚠ THE STAMP AND THE CUTOFF MUST COME FROM ONE CLOCK, OR THE SEND-ONCE GUARANTEE IS ONLY
 * AS GOOD AS NTP. `claim` stamps `claimed_at = now()`, and this predicate compares against
 * `now() - interval`, so both readings come from the single Postgres instance every replica
 * shares. Computing the cutoff app-side (`new Date() - ttl`) and passing it in would have
 * reintroduced two failure modes the ADR claims are closed:
 *
 *  · CLOCK SKEW — a replica running >TTL ahead of the one that took the claim computes a
 *    cutoff later than the stamp and reclaims a live, in-flight row ⇒ DOUBLE SEND.
 *  · A SLOW TICK — the tick captures `now` once and works a bounded batch; BullMQ enqueues
 *    the next tick every minute regardless of progress. A tick still running TTL later has
 *    its own rows reclaimed underneath it by the newer tick ⇒ DOUBLE SEND. (A DB-clock
 *    cutoff does not fix a tick that genuinely overruns the TTL, but it removes skew as an
 *    independent cause and makes the remaining window a single, reasoned-about quantity.)
 *
 * POLICY STILL COMES FROM THE CALLER: the TTL arrives as `claimTtlMinutes`, bound as a
 * parameter to `make_interval`, never as a literal spliced into SQL. This file knows how to
 * ask "is this claim stale?", not how long a claim may be held.
 */
function staleClaim(claimTtlMinutes: number): SQL {
  return sql`${scheduledNotifications.claimedAt} < now() - make_interval(mins => ${claimTtlMinutes}::int)`;
}

/** What a `schedule()` call did. See `scheduledNotificationModeEnum`. */
export type ScheduleOutcome = 'scheduled' | 'already_pending' | 'replaced';

export interface ScheduleNotificationInput {
  /** Caller-owned dedup + cancel handle. */
  dedupeKey: string;
  /** The notification event to publish at fire time. */
  event: string;
  /** Self-sufficient at fire time; ISO strings, never `Date`s (see the schema's jsonb note). */
  payload: ScheduledNotificationPayload;
  /** A time in the PAST is legal — the next tick fires it. Not clamped, not rejected. */
  scheduledFor: Date;
  /** Defaults to `first_wins` (the conservative one — a duplicate schedule is a no-op). */
  mode?: ScheduledNotificationMode;
  /** Name of the fire-time guard in the recheck registry. Omit for an unconditional send. */
  recheck?: string | null;
}

export interface ScheduleNotificationResult {
  outcome: ScheduleOutcome;
  row: ScheduledNotification;
}

export interface ListDueInput {
  /**
   * Pending rows with `scheduled_for <= now` are due.
   *
   * Deliberately the CALLER'S tick clock, not `now()`: this is a POLICY question ("what is
   * due as of this tick"), and its worst failure under skew is a promise firing early or
   * late by the skew — a latency artefact, never a double send. The send-once-critical
   * comparison is `staleClaim`, which is DB-clock on both sides.
   */
  now: Date;
  /** Claim TTL in minutes. Applied against the DATABASE clock — see `staleClaim`. */
  claimTtlMinutes: number;
  /** Bounds a post-outage backlog per tick. */
  limit: number;
}

export interface ClaimInput {
  id: string;
  /** Claim TTL in minutes. Applied against the DATABASE clock — see `staleClaim`. */
  claimTtlMinutes: number;
  /** A row that has already been claimed this many times is terminal, never re-claimed. */
  maxAttempts: number;
}

/** Thrown when a terminal mark targets a row that does not exist (or is soft-deleted). */
export class ScheduledNotificationNotFoundError extends Error {
  constructor(id: string) {
    super(`Scheduled notification not found: ${id}`);
    this.name = 'ScheduledNotificationNotFoundError';
  }
}

/**
 * Stamp a terminal status on one live row. Shared by the three `mark*` methods so the
 * live-row guard, the `updated_at` bump and the not-found error are defined exactly once.
 *
 * FAILS LOUD on a miss. A terminal mark that silently did nothing would leave the row
 * `claimed`, and the next tick past the claim TTL would re-publish a notification that has
 * already been sent — precisely the failure this table exists to prevent.
 */
async function markTerminal(
  id: string,
  set: Partial<typeof scheduledNotifications.$inferInsert>,
  exec: DbExecutor
): Promise<void> {
  const [row] = await exec
    .update(scheduledNotifications)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(scheduledNotifications.id, id), isNull(scheduledNotifications.deletedAt)))
    .returning({ id: scheduledNotifications.id });
  if (row === undefined) {
    throw new ScheduledNotificationNotFoundError(id);
  }
}

/**
 * `scheduledNotificationsRepository` (BAL-420 / ADR-1047) — the data-access layer for the
 * durable "publish this event later, once, unless the reason has gone away" record.
 *
 * POLICY-FREE BY CONSTRUCTION. Every window and every ceiling — `now`, `claimTtlMinutes`,
 * `maxAttempts`, `limit` — is SUPPLIED BY THE CALLER, the same contract as
 * `listPendingAutoAccept(cutoff)` / `listOpenCreatedBefore(cutoff)`. This file knows how to
 * move a row between states; it does not know how long a claim may be held or how many
 * attempts are too many.
 *
 * ⚠ THE CLAIM TTL ARRIVES AS A DURATION, NOT A PRE-COMPUTED CUTOFF, and that distinction is
 * load-bearing rather than stylistic: the cutoff is evaluated against `now()` INSIDE
 * Postgres, on the same clock that stamps `claimed_at`, so no replica's wall clock can make
 * a live claim look reclaimable. See `staleClaim`. (`mark*` and `cancel` still stamp
 * `new Date()` — those are terminal writes that nothing races on a deadline.)
 *
 * ⚠ NO METHOD ON THE CLAIM PATH CATCHES ANYTHING. `claim` in particular must FAIL LOUD:
 * it is not telemetry, it IS the send-once guarantee, and a swallowed error there converts
 * "we lost the race" into "we won it". The dispatch tick logs and moves on; the row is
 * retried next tick. (Contrast `logNotification`, whose swallowing catch is correct —
 * a best-effort audit write must never fail a send.)
 *
 * Every method takes an OPTIONAL executor as its last argument, so an `apps/api` caller can
 * write the schedule row INSIDE its own domain transaction — a real outbox for those
 * consumers, and the reason ADR R8's fire-and-forget durability gap does not apply to
 * API-side callers. Precedent: `partyMembershipsRepository.getMemberRole(..., exec)`.
 */
export const scheduledNotificationsRepository = {
  /**
   * Ensure a pending promise exists for `dedupeKey`, folding on the partial unique index.
   *
   *   `first_wins`      → the existing pending row STANDS UNTOUCHED, keeping its original
   *                       `scheduled_for`, `payload`, `event` and `recheck`. ⇒ `already_pending`
   *   `replace_pending` → the new schedule SUPERSEDES all four. ⇒ `replaced`
   *
   * BOTH modes are expressed as `ON CONFLICT … DO UPDATE`, differing only in the `set`;
   * `first_wins`'s set is the self-assignment `updated_at = updated_at`.
   *
   * WHY NOT `DO NOTHING` FOR `first_wins` — it returns zero rows on a conflict, so the
   * outcome could only be reported by a SECOND query for the existing row, and that query
   * races: the row can be claimed between the two statements, and the follow-up read then
   * finds nothing to return. `DO UPDATE` with a no-op set returns the conflicting row from
   * the SAME statement, under the same row lock. The self-assignment also leaves
   * `updated_at`'s VALUE unchanged, so "`updated_at` moved" continues to mean "this pending
   * row was genuinely superseded" — which is the only bookkeeping ADR Decision 6 keeps.
   *
   * The insert-vs-conflict distinction comes from a CLIENT-MINTED `id`: if the returned row
   * carries the id we generated, our insert won; any other id is the pre-existing row. This
   * is deterministic, unlike comparing `created_at`/`updated_at` — inside one transaction
   * `now()` is constant, so timestamp comparison is not merely fragile but wrong.
   *
   * ⚠ THE STORED `mode` COLUMN IS DESCRIPTIVE, NOT AN INPUT TO ANYTHING. Behaviour is decided
   * per CALL by this argument, never read back off the row — so a `first_wins` call against a
   * row written by an earlier `replace_pending` call folds as `first_wins`, and leaves the
   * stored `mode` reading `replace_pending`. Nothing downstream (claim, recheck, dispatch)
   * consults it; it records how the row was last written, for the ops read.
   */
  async schedule(
    input: ScheduleNotificationInput,
    exec: DbExecutor = db
  ): Promise<ScheduleNotificationResult> {
    const mode: ScheduledNotificationMode = input.mode ?? 'first_wins';
    const mintedId = randomUUID();

    const set =
      mode === 'replace_pending'
        ? {
            event: input.event,
            payload: input.payload,
            scheduledFor: input.scheduledFor,
            recheck: input.recheck ?? null,
            mode,
            updatedAt: new Date(),
          }
        : // `first_wins` — a deliberate no-op so the existing promise is returned unchanged.
          { updatedAt: sql`${scheduledNotifications.updatedAt}` };

    const [row] = await exec
      .insert(scheduledNotifications)
      .values({
        id: mintedId,
        dedupeKey: input.dedupeKey,
        event: input.event,
        payload: input.payload,
        scheduledFor: input.scheduledFor,
        mode,
        recheck: input.recheck ?? null,
      })
      .onConflictDoUpdate({
        target: scheduledNotifications.dedupeKey,
        targetWhere: PENDING_ARBITER,
        set,
      })
      .returning();

    if (row === undefined) {
      throw new Error(`Failed to schedule notification for key: ${input.dedupeKey}`);
    }
    if (row.id === mintedId) {
      return { outcome: 'scheduled', row };
    }
    return { outcome: mode === 'replace_pending' ? 'replaced' : 'already_pending', row };
  },

  /**
   * Void the pending promise for `dedupeKey`. Returns how many rows were cancelled —
   * **zero is NORMAL, not an error** (nothing was scheduled, or it already fired).
   *
   * A `claimed` ROW IS DELIBERATELY NOT CANCELLABLE. Racing a cancel into an in-flight send
   * is exactly the class of bug that produces "we cancelled it and it sent anyway". The
   * fire-time recheck — which reads LIVE state after the claim — is the authority on whether
   * the notification is still warranted; cancellation is an optimisation on top of it
   * (ADR Decision 5).
   *
   * When a cancel and a claim contend for the same row, Postgres serialises the two UPDATEs
   * and exactly one wins: if cancel wins the row is never selected again; if the claim wins
   * the recheck reads live state and skips. No double-send and no false-send on either
   * ordering.
   */
  async cancel(dedupeKey: string, exec: DbExecutor = db): Promise<number> {
    const now = new Date();
    const rows = await exec
      .update(scheduledNotifications)
      .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
      .where(
        and(
          eq(scheduledNotifications.dedupeKey, dedupeKey),
          eq(scheduledNotifications.status, 'pending'),
          isNull(scheduledNotifications.deletedAt)
        )
      )
      .returning({ id: scheduledNotifications.id });
    return rows.length;
  },

  /**
   * The tick's due-scan, in ONE pass over both work sources:
   *   · `pending` rows whose `scheduled_for` has passed — ordinary due work;
   *   · `claimed` rows stranded past the claim TTL — the reconcile for a send that died
   *     after taking its claim. Staleness is judged on the DATABASE clock (`staleClaim`),
   *     the same clock that stamped `claimed_at`.
   *
   * `ORDER BY scheduled_for ASC` + `LIMIT` bound a post-outage backlog: the oldest promises
   * drain first, at a fixed rate per tick, instead of one thundering batch (ADR R4).
   *
   * Returning a row here promises NOTHING — it is a candidate list. `claim` is the gate.
   */
  async listDue(input: ListDueInput, exec: DbExecutor = db): Promise<ScheduledNotification[]> {
    return exec
      .select()
      .from(scheduledNotifications)
      .where(
        and(
          isNull(scheduledNotifications.deletedAt),
          or(
            and(
              eq(scheduledNotifications.status, 'pending'),
              lte(scheduledNotifications.scheduledFor, input.now)
            ),
            and(eq(scheduledNotifications.status, 'claimed'), staleClaim(input.claimTtlMinutes))
          )
        )
      )
      .orderBy(asc(scheduledNotifications.scheduledFor))
      .limit(input.limit);
  },

  /**
   * ⚠ THE SEND-ONCE GATE. ONE conditional `UPDATE … RETURNING`, which takes the row lock and
   * performs the state transition together, so exactly one caller can ever observe it —
   * correct across multiple Railway replicas, each of which registers the same per-minute
   * cron. No advisory lock and no `SELECT … FOR UPDATE`: both would be a second mechanism
   * guarding what a single statement already guards.
   *
   * `undefined` ⇒ THE CALLER PUBLISHES NOTHING. It means one of: another worker won the
   * race; the row was cancelled; the row is claimed and not yet past its TTL; attempts are
   * exhausted; or the row is soft-deleted. The caller does not need to know which — every
   * one of them means "not yours to send".
   *
   * `attempts` is incremented BY THE CLAIM, not by the send, so a process that dies between
   * claiming and publishing still consumes an attempt and cannot retry forever.
   *
   * ⚠ `claimed_at` IS STAMPED `now()` — THE DATABASE CLOCK, NOT THE CALLER'S. It is compared
   * against a cutoff drawn from that same clock (`staleClaim`), so neither replica clock skew
   * nor a caller that captured its `now` minutes earlier can make a live claim look stale and
   * get it reclaimed underneath its owner. `updated_at` follows the same clock for coherence.
   *
   * ⚠ NO try/catch. Idempotency depends on this write; a swallowed error here would turn
   * "we lost the race" into "we won it" and send the notification twice.
   */
  async claim(
    input: ClaimInput,
    exec: DbExecutor = db
  ): Promise<ScheduledNotification | undefined> {
    const [claimed] = await exec
      .update(scheduledNotifications)
      .set({
        status: 'claimed',
        claimedAt: sql`now()`,
        attempts: sql`${scheduledNotifications.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(scheduledNotifications.id, input.id),
          isNull(scheduledNotifications.deletedAt),
          lt(scheduledNotifications.attempts, input.maxAttempts),
          or(
            eq(scheduledNotifications.status, 'pending'),
            and(eq(scheduledNotifications.status, 'claimed'), staleClaim(input.claimTtlMinutes))
          )
        )
      )
      .returning();
    return claimed;
  },

  /** Terminal, happy path: the event was handed to `publish()`. */
  async markPublished(id: string, exec: DbExecutor = db): Promise<void> {
    await markTerminal(id, { status: 'published', publishedAt: new Date() }, exec);
  },

  /**
   * Terminal and NORMAL: the fire-time recheck said this notification is no longer
   * warranted. Writes `skip_reason`, never `last_error` — a skip must not read as, or be
   * counted as, a failure.
   */
  async markSkipped(id: string, reason: string, exec: DbExecutor = db): Promise<void> {
    await markTerminal(id, { status: 'skipped', skipReason: reason }, exec);
  },

  /**
   * Terminal FAILURE: attempts exhausted, or a `recheck` name that is not registered (the
   * deploy-skew case — failing closed on an unknown guard is the only safe reading). Writes
   * `last_error`, never `skip_reason`.
   */
  async markFailed(id: string, error: string, exec: DbExecutor = db): Promise<void> {
    await markTerminal(id, { status: 'failed', lastError: error }, exec);
  },

  /**
   * Every live row for a key, newest first — the ops answer to "what are we about to send,
   * and why hasn't it fired?". Across ALL statuses, which is why the non-partial
   * `scheduled_notification_key_idx` exists alongside the partial unique.
   */
  async findByDedupeKey(
    dedupeKey: string,
    exec: DbExecutor = db
  ): Promise<ScheduledNotification[]> {
    return exec
      .select()
      .from(scheduledNotifications)
      .where(
        and(
          eq(scheduledNotifications.dedupeKey, dedupeKey),
          isNull(scheduledNotifications.deletedAt)
        )
      )
      .orderBy(desc(scheduledNotifications.createdAt), desc(scheduledNotifications.id));
  },
};
