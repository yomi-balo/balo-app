import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { scheduledNotifications } from '../schema';
import { scheduledNotificationFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import {
  scheduledNotificationsRepository,
  ScheduledNotificationNotFoundError,
} from './scheduled-notifications';

const MINUTE_MS = 60_000;
const CLAIM_TTL_MINUTES = 5;

/** A fresh key per case — the partial unique is global, and cases must not collide. */
function key(): string {
  return `sched-test:${randomUUID()}`;
}

/**
 * The tick's own policy, restated here so the tests never reach into the job module.
 *
 * ⚠ NO `now` AND NO `reclaimBefore`. Staleness is judged entirely on the DATABASE clock
 * (`now() - make_interval(mins => …)`), so the caller supplies the TTL as a POLICY value and
 * never a computed cutoff. Passing a cutoff would have reintroduced the clock-skew and
 * slow-tick double-send windows the design claims are closed.
 */
function claimArgs(id: string, maxAttempts = 3) {
  return { id, claimTtlMinutes: CLAIM_TTL_MINUTES, maxAttempts };
}

/**
 * Ask POSTGRES whether a row's `claimed_at` / `updated_at` equal `now()`.
 *
 * The comparison is done IN the database, at the column's own microsecond precision, so it
 * neither round-trips a timestamp through JavaScript's millisecond `Date` nor depends on
 * how the driver formats one. `now()` is `transaction_timestamp()` — constant for the life
 * of a transaction — and the harness runs each test inside one, so a DB-stamped value is
 * EXACTLY equal here while any app-computed value could not be.
 */
async function stampsMatchDbClock(id: string): Promise<{ claimedAt: boolean; updatedAt: boolean }> {
  const [probe] = await db
    .select({
      claimedAt: sql<boolean>`${scheduledNotifications.claimedAt} = now()`,
      updatedAt: sql<boolean>`${scheduledNotifications.updatedAt} = now()`,
    })
    .from(scheduledNotifications)
    .where(eq(scheduledNotifications.id, id));
  if (probe === undefined) {
    throw new Error(`row ${id} not found`);
  }
  return probe;
}

async function reload(id: string) {
  const [row] = await db
    .select()
    .from(scheduledNotifications)
    .where(eq(scheduledNotifications.id, id));
  return row;
}

// ── schedule ────────────────────────────────────────────────────────────

describe('scheduledNotificationsRepository.schedule', () => {
  it('inserts a pending row with the given scheduled_for, mode and recheck', async () => {
    const dedupeKey = key();
    const scheduledFor = new Date(Date.now() + 30 * MINUTE_MS);

    const { outcome, row } = await scheduledNotificationsRepository.schedule({
      dedupeKey,
      event: 'meeting.participant_absent',
      payload: { meetingId: 'm-1' },
      scheduledFor,
      mode: 'replace_pending',
      recheck: 'meeting_participant_absent',
    });

    expect(outcome).toBe('scheduled');
    expect(row.dedupeKey).toBe(dedupeKey);
    expect(row.event).toBe('meeting.participant_absent');
    expect(row.status).toBe('pending');
    expect(row.mode).toBe('replace_pending');
    expect(row.recheck).toBe('meeting_participant_absent');
    expect(row.scheduledFor.toISOString()).toBe(scheduledFor.toISOString());
    expect(row.attempts).toBe(0);
    expect(row.claimedAt).toBeNull();
    expect(row.publishedAt).toBeNull();
    expect(row.cancelledAt).toBeNull();
    expect(row.skipReason).toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.deletedAt).toBeNull();
  });

  it('defaults to mode=first_wins and recheck=NULL', async () => {
    const { row } = await scheduledNotificationsRepository.schedule({
      dedupeKey: key(),
      event: 'reschedule_proposal.unanswered',
      payload: {},
      scheduledFor: new Date(),
    });

    expect(row.mode).toBe('first_wins');
    expect(row.recheck).toBeNull();
  });

  it('accepts a scheduled_for in the PAST — the next tick fires it, no clamping', async () => {
    const scheduledFor = new Date(Date.now() - 10 * MINUTE_MS);

    const { outcome, row } = await scheduledNotificationsRepository.schedule({
      dedupeKey: key(),
      event: 'meeting.participant_absent',
      payload: {},
      scheduledFor,
    });

    expect(outcome).toBe('scheduled');
    expect(row.scheduledFor.toISOString()).toBe(scheduledFor.toISOString());
  });

  it('first_wins on a live pending key → already_pending, ONE row, original values intact', async () => {
    const dedupeKey = key();
    const originalAt = new Date(Date.now() + 10 * MINUTE_MS);

    const first = await scheduledNotificationsRepository.schedule({
      dedupeKey,
      event: 'meeting.participant_absent',
      payload: { attempt: 'first' },
      scheduledFor: originalAt,
      recheck: 'original_recheck',
    });

    const second = await scheduledNotificationsRepository.schedule({
      dedupeKey,
      event: 'some.other_event',
      payload: { attempt: 'second' },
      scheduledFor: new Date(Date.now() + 90 * MINUTE_MS),
      mode: 'first_wins',
      recheck: 'replacement_recheck',
    });

    expect(second.outcome).toBe('already_pending');
    expect(second.row.id).toBe(first.row.id);
    // The existing promise STANDS — every superseding field untouched.
    expect(second.row.event).toBe('meeting.participant_absent');
    expect(second.row.payload).toEqual({ attempt: 'first' });
    expect(second.row.scheduledFor.toISOString()).toBe(originalAt.toISOString());
    expect(second.row.recheck).toBe('original_recheck');
    // …and `updated_at` did NOT move, so "updated_at moved" still means "superseded".
    expect(second.row.updatedAt.toISOString()).toBe(first.row.updatedAt.toISOString());

    const all = await scheduledNotificationsRepository.findByDedupeKey(dedupeKey);
    expect(all).toHaveLength(1);
  });

  it('replace_pending on a live pending key → replaced, ONE row, NEW values', async () => {
    const dedupeKey = key();
    const newAt = new Date(Date.now() + 90 * MINUTE_MS);

    const first = await scheduledNotificationsRepository.schedule({
      dedupeKey,
      event: 'meeting.participant_absent',
      payload: { attempt: 'first' },
      scheduledFor: new Date(Date.now() + 10 * MINUTE_MS),
      recheck: 'original_recheck',
    });

    const second = await scheduledNotificationsRepository.schedule({
      dedupeKey,
      event: 'conversation.unread_digest',
      payload: { attempt: 'second' },
      scheduledFor: newAt,
      mode: 'replace_pending',
      recheck: 'conversation_unread',
    });

    expect(second.outcome).toBe('replaced');
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.event).toBe('conversation.unread_digest');
    expect(second.row.payload).toEqual({ attempt: 'second' });
    expect(second.row.scheduledFor.toISOString()).toBe(newAt.toISOString());
    expect(second.row.recheck).toBe('conversation_unread');
    expect(second.row.mode).toBe('replace_pending');
    expect(second.row.status).toBe('pending');

    const all = await scheduledNotificationsRepository.findByDedupeKey(dedupeKey);
    expect(all).toHaveLength(1);
  });

  /**
   * ⚠ THE `status = 'pending'` HALF OF THE PARTIAL UNIQUE, PROVEN.
   *
   * Without it — a bare `UNIQUE (dedupe_key)` — a key could carry ONE notification EVER. For
   * a conversation-scoped key that is one new-message email per thread for the thread's
   * entire lifetime. Each terminal status is checked, not just `published`, because every one
   * of them frees the slot and all four are reachable.
   */
  it.each(['published', 'cancelled', 'skipped', 'failed'] as const)(
    'RE-SCHEDULABILITY: a key whose row is terminal (%s) accepts a NEW pending row',
    async (terminalStatus) => {
      const dedupeKey = key();

      const first = await scheduledNotificationsRepository.schedule({
        dedupeKey,
        event: 'meeting.participant_absent',
        payload: { round: 1 },
        scheduledFor: new Date(),
      });

      await db
        .update(scheduledNotifications)
        .set({ status: terminalStatus })
        .where(eq(scheduledNotifications.id, first.row.id));

      const second = await scheduledNotificationsRepository.schedule({
        dedupeKey,
        event: 'meeting.participant_absent',
        payload: { round: 2 },
        scheduledFor: new Date(),
      });

      expect(second.outcome).toBe('scheduled');
      expect(second.row.id).not.toBe(first.row.id);
      expect(second.row.status).toBe('pending');
      expect(await scheduledNotificationsRepository.findByDedupeKey(dedupeKey)).toHaveLength(2);
    }
  );

  it('a SOFT-DELETED pending row does not block re-scheduling the key', async () => {
    const dedupeKey = key();
    const first = await scheduledNotificationFactory({ dedupeKey });
    await db
      .update(scheduledNotifications)
      .set({ deletedAt: new Date() })
      .where(eq(scheduledNotifications.id, first.id));

    const second = await scheduledNotificationsRepository.schedule({
      dedupeKey,
      event: 'meeting.participant_absent',
      payload: {},
      scheduledFor: new Date(),
    });

    expect(second.outcome).toBe('scheduled');
    expect(second.row.id).not.toBe(first.id);
  });

  it('rejects a blank dedupe key (CHECK scheduled_notification_dedupe_key_nonempty)', async () => {
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(scheduledNotifications).values({
        dedupeKey: '   ',
        event: 'meeting.participant_absent',
        payload: {},
        scheduledFor: new Date(),
      })
    );
  });

  /**
   * THE jsonb TYPE-LIE GUARD (ADR R9). `payload` is typed as the STORED shape, so a
   * timestamp round-trips as the ISO STRING it actually is. If anyone re-types the column
   * with a `Date` field, this stays green while every read silently lies — hence the
   * explicit `typeof` assertion rather than a value comparison.
   */
  it('round-trips an ISO timestamp in the payload as a STRING, not a Date', async () => {
    const iso = '2026-08-05T09:30:00.000Z';
    const { row } = await scheduledNotificationsRepository.schedule({
      dedupeKey: key(),
      event: 'meeting.participant_absent',
      payload: { scheduledStart: iso, nested: { endsAt: iso } },
      scheduledFor: new Date(),
    });

    const reloaded = await reload(row.id);
    const payload = reloaded?.payload as { scheduledStart: unknown; nested: { endsAt: unknown } };
    expect(typeof payload.scheduledStart).toBe('string');
    expect(payload.scheduledStart).toBe(iso);
    expect(typeof payload.nested.endsAt).toBe('string');
    expect(payload.scheduledStart).not.toBeInstanceOf(Date);
  });
});

// ── cancel ──────────────────────────────────────────────────────────────

describe('scheduledNotificationsRepository.cancel', () => {
  it('moves a pending row to cancelled, stamps cancelled_at, and returns 1', async () => {
    const dedupeKey = key();
    const { row } = await scheduledNotificationsRepository.schedule({
      dedupeKey,
      event: 'meeting.participant_absent',
      payload: {},
      scheduledFor: new Date(Date.now() + MINUTE_MS),
    });

    expect(await scheduledNotificationsRepository.cancel(dedupeKey)).toBe(1);

    const reloaded = await reload(row.id);
    expect(reloaded?.status).toBe('cancelled');
    expect(reloaded?.cancelledAt).toBeInstanceOf(Date);
  });

  it('returns 0 on a second cancel — zero is NORMAL, not an error', async () => {
    const dedupeKey = key();
    await scheduledNotificationsRepository.schedule({
      dedupeKey,
      event: 'meeting.participant_absent',
      payload: {},
      scheduledFor: new Date(),
    });

    expect(await scheduledNotificationsRepository.cancel(dedupeKey)).toBe(1);
    expect(await scheduledNotificationsRepository.cancel(dedupeKey)).toBe(0);
  });

  it('returns 0 for a key that was never scheduled', async () => {
    expect(await scheduledNotificationsRepository.cancel(key())).toBe(0);
  });

  it('does NOT cancel a CLAIMED row — racing a cancel into an in-flight send is the bug', async () => {
    const dedupeKey = key();
    const row = await scheduledNotificationFactory({
      dedupeKey,
      values: { status: 'claimed', claimedAt: new Date(), attempts: 1 },
    });

    expect(await scheduledNotificationsRepository.cancel(dedupeKey)).toBe(0);
    expect((await reload(row.id))?.status).toBe('claimed');
  });

  it('does not cancel a soft-deleted pending row', async () => {
    const dedupeKey = key();
    await scheduledNotificationFactory({ dedupeKey, values: { deletedAt: new Date() } });

    expect(await scheduledNotificationsRepository.cancel(dedupeKey)).toBe(0);
  });
});

// ── claim — the send-once gate ──────────────────────────────────────────

describe('scheduledNotificationsRepository.claim', () => {
  it('claims a pending row: status=claimed, attempts=1, claimed_at stamped', async () => {
    const row = await scheduledNotificationFactory();

    const claimed = await scheduledNotificationsRepository.claim(claimArgs(row.id));

    expect(claimed).toBeDefined();
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.claimedAt).not.toBeNull();
  });

  /**
   * ⚠ THE CLOCK PROOF. `claimed_at` is stamped `now()` — Postgres's clock, the one every
   * Railway replica shares — and NOT a `Date` the caller computed. `now()` is
   * `transaction_timestamp()`, constant for the life of a transaction, so inside this
   * harness's per-test transaction the stamp is EXACTLY the value `select now()` returns.
   * That exactness is the assertion: an app-supplied stamp could not match it.
   *
   * Why it matters: the reclaim cutoff is `now() - interval`, drawn from this same clock.
   * If the stamp came from the app instead, a replica whose wall clock ran more than the TTL
   * ahead would compute a cutoff LATER than a live claim's stamp, reclaim a row another
   * worker was actively sending, and DOUBLE SEND.
   */
  it('stamps claimed_at from the DATABASE clock, not the caller-supplied one', async () => {
    const row = await scheduledNotificationFactory();

    await scheduledNotificationsRepository.claim(claimArgs(row.id));

    // `updated_at` follows the same clock, so the two can never disagree on one row.
    expect(await stampsMatchDbClock(row.id)).toEqual({ claimedAt: true, updatedAt: true });
  });

  /**
   * ⚠ THE SEND-ONCE PROOF. The integration harness runs every test on a `max: 1` pool inside
   * one outer transaction (`test/setup-integration.ts`), so two genuinely simultaneous
   * connections are not expressible here. That is not a weakened test: the guarantee is a
   * property of the conditional `UPDATE`'s own `WHERE`, and two claims against the SAME row
   * exercise exactly the predicate that decides the race. Postgres serialises concurrent
   * writers onto the same row lock, which reduces the concurrent case to this sequential
   * one — the second writer re-evaluates the predicate against the winner's committed row.
   */
  it('two claims of the same row → exactly ONE winner; the second returns undefined', async () => {
    const row = await scheduledNotificationFactory();

    const first = await scheduledNotificationsRepository.claim(claimArgs(row.id));
    const second = await scheduledNotificationsRepository.claim(claimArgs(row.id));

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect((await reload(row.id))?.attempts).toBe(1);
  });

  it('never claims a CANCELLED row', async () => {
    const row = await scheduledNotificationFactory({
      values: { status: 'cancelled', cancelledAt: new Date() },
    });

    expect(await scheduledNotificationsRepository.claim(claimArgs(row.id))).toBeUndefined();
  });

  it.each(['published', 'skipped', 'failed'] as const)(
    'never claims a terminal row (%s)',
    async (status) => {
      const row = await scheduledNotificationFactory({ values: { status } });
      expect(await scheduledNotificationsRepository.claim(claimArgs(row.id))).toBeUndefined();
    }
  );

  it('never claims a soft-deleted row', async () => {
    const row = await scheduledNotificationFactory({ values: { deletedAt: new Date() } });
    expect(await scheduledNotificationsRepository.claim(claimArgs(row.id))).toBeUndefined();
  });

  it('does NOT reclaim a fresh claimed row (inside the TTL)', async () => {
    const row = await scheduledNotificationFactory({
      values: {
        status: 'claimed',
        claimedAt: new Date(Date.now() - MINUTE_MS), // 1 min old, TTL is 5
        attempts: 1,
      },
    });

    expect(await scheduledNotificationsRepository.claim(claimArgs(row.id))).toBeUndefined();
  });

  it('RECLAIMS a stranded claimed row past the TTL, incrementing attempts to 2', async () => {
    const row = await scheduledNotificationFactory({
      values: {
        status: 'claimed',
        claimedAt: new Date(Date.now() - 10 * MINUTE_MS), // stale: TTL is 5
        attempts: 1,
      },
    });

    const reclaimed = await scheduledNotificationsRepository.claim(claimArgs(row.id));

    expect(reclaimed).toBeDefined();
    expect(reclaimed?.attempts).toBe(2);
    // RE-stamped from the DB clock, so the reclaimer's own TTL starts now rather than
    // inheriting the dead worker's.
    expect((await stampsMatchDbClock(row.id)).claimedAt).toBe(true);
  });

  it('the TTL is a CALLER-SUPPLIED policy value, not a repository constant', async () => {
    const row = await scheduledNotificationFactory({
      values: {
        status: 'claimed',
        claimedAt: new Date(Date.now() - 3 * MINUTE_MS), // 3 min old
        attempts: 1,
      },
    });

    // Fresh under a 5-minute TTL…
    expect(
      await scheduledNotificationsRepository.claim({
        id: row.id,
        claimTtlMinutes: 5,
        maxAttempts: 3,
      })
    ).toBeUndefined();
    // …stale under a 1-minute one. Same row, same clock, different policy.
    expect(
      await scheduledNotificationsRepository.claim({
        id: row.id,
        claimTtlMinutes: 1,
        maxAttempts: 3,
      })
    ).toBeDefined();
  });

  it('ATTEMPTS EXHAUSTION IS TERMINAL: a row already at maxAttempts is never claimed again', async () => {
    const row = await scheduledNotificationFactory({
      values: {
        status: 'claimed',
        claimedAt: new Date(Date.now() - 10 * MINUTE_MS),
        attempts: 3,
      },
    });

    expect(await scheduledNotificationsRepository.claim(claimArgs(row.id, 3))).toBeUndefined();
    // Not even a pending row escapes the ceiling.
    await db
      .update(scheduledNotifications)
      .set({ status: 'pending' })
      .where(eq(scheduledNotifications.id, row.id));
    expect(await scheduledNotificationsRepository.claim(claimArgs(row.id, 3))).toBeUndefined();
  });

  it('claims the LAST allowed attempt (attempts = maxAttempts - 1)', async () => {
    const row = await scheduledNotificationFactory({
      values: {
        status: 'claimed',
        claimedAt: new Date(Date.now() - 10 * MINUTE_MS),
        attempts: 2,
      },
    });

    const claimed = await scheduledNotificationsRepository.claim(claimArgs(row.id, 3));
    expect(claimed?.attempts).toBe(3);
  });

  it('returns undefined for an unknown id rather than throwing', async () => {
    expect(await scheduledNotificationsRepository.claim(claimArgs(randomUUID()))).toBeUndefined();
  });
});

// ── listDue ─────────────────────────────────────────────────────────────

describe('scheduledNotificationsRepository.listDue', () => {
  function dueArgs(now = new Date(), limit = 100) {
    return { now, claimTtlMinutes: CLAIM_TTL_MINUTES, limit };
  }

  it('includes pending rows at or before now and EXCLUDES future ones', async () => {
    const now = new Date();
    const due = await scheduledNotificationFactory({
      values: { scheduledFor: new Date(now.getTime() - MINUTE_MS) },
    });
    const exactlyNow = await scheduledNotificationFactory({ values: { scheduledFor: now } });
    const future = await scheduledNotificationFactory({
      values: { scheduledFor: new Date(now.getTime() + MINUTE_MS) },
    });

    const ids = (await scheduledNotificationsRepository.listDue(dueArgs(now))).map((r) => r.id);

    expect(ids).toContain(due.id);
    expect(ids).toContain(exactlyNow.id); // `<=` — the boundary is inclusive
    expect(ids).not.toContain(future.id);
  });

  it('includes STALE claimed rows (the reconcile) and excludes fresh ones', async () => {
    const now = new Date();
    const stale = await scheduledNotificationFactory({
      values: { status: 'claimed', claimedAt: new Date(now.getTime() - 10 * MINUTE_MS) },
    });
    const fresh = await scheduledNotificationFactory({
      values: { status: 'claimed', claimedAt: new Date(now.getTime() - MINUTE_MS) },
    });

    const ids = (await scheduledNotificationsRepository.listDue(dueArgs(now))).map((r) => r.id);

    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);
  });

  it.each(['published', 'cancelled', 'skipped', 'failed'] as const)(
    'excludes terminal rows (%s) however overdue',
    async (status) => {
      const now = new Date();
      const row = await scheduledNotificationFactory({
        values: { status, scheduledFor: new Date(now.getTime() - 60 * MINUTE_MS) },
      });

      const ids = (await scheduledNotificationsRepository.listDue(dueArgs(now))).map((r) => r.id);
      expect(ids).not.toContain(row.id);
    }
  );

  it('excludes soft-deleted rows', async () => {
    const now = new Date();
    const row = await scheduledNotificationFactory({
      values: { scheduledFor: new Date(now.getTime() - MINUTE_MS), deletedAt: new Date() },
    });

    const ids = (await scheduledNotificationsRepository.listDue(dueArgs(now))).map((r) => r.id);
    expect(ids).not.toContain(row.id);
  });

  it('orders by scheduled_for ASC and respects the limit — oldest promises drain first', async () => {
    const now = new Date();
    const oldest = await scheduledNotificationFactory({
      values: { scheduledFor: new Date(now.getTime() - 30 * MINUTE_MS) },
    });
    const middle = await scheduledNotificationFactory({
      values: { scheduledFor: new Date(now.getTime() - 20 * MINUTE_MS) },
    });
    await scheduledNotificationFactory({
      values: { scheduledFor: new Date(now.getTime() - 10 * MINUTE_MS) },
    });

    const page = await scheduledNotificationsRepository.listDue(dueArgs(now, 2));

    expect(page).toHaveLength(2);
    expect(page.map((r) => r.id)).toEqual([oldest.id, middle.id]);
  });
});

// ── terminal marks ──────────────────────────────────────────────────────

describe('scheduledNotificationsRepository terminal marks', () => {
  it('markPublished sets status + published_at and leaves skip_reason / last_error NULL', async () => {
    const row = await scheduledNotificationFactory();

    await scheduledNotificationsRepository.markPublished(row.id);

    const reloaded = await reload(row.id);
    expect(reloaded?.status).toBe('published');
    expect(reloaded?.publishedAt).toBeInstanceOf(Date);
    expect(reloaded?.skipReason).toBeNull();
    expect(reloaded?.lastError).toBeNull();
  });

  it('markSkipped writes skip_reason ONLY — a skip is normal, never a failure', async () => {
    const row = await scheduledNotificationFactory();

    await scheduledNotificationsRepository.markSkipped(row.id, 'all_read');

    const reloaded = await reload(row.id);
    expect(reloaded?.status).toBe('skipped');
    expect(reloaded?.skipReason).toBe('all_read');
    expect(reloaded?.lastError).toBeNull();
    expect(reloaded?.publishedAt).toBeNull();
  });

  it('markFailed writes last_error ONLY', async () => {
    const row = await scheduledNotificationFactory();

    await scheduledNotificationsRepository.markFailed(row.id, 'unregistered recheck: gone_away');

    const reloaded = await reload(row.id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.lastError).toBe('unregistered recheck: gone_away');
    expect(reloaded?.skipReason).toBeNull();
    expect(reloaded?.publishedAt).toBeNull();
  });

  it.each([
    ['markPublished', (id: string) => scheduledNotificationsRepository.markPublished(id)],
    ['markSkipped', (id: string) => scheduledNotificationsRepository.markSkipped(id, 'r')],
    ['markFailed', (id: string) => scheduledNotificationsRepository.markFailed(id, 'e')],
  ] as const)('%s FAILS LOUD on an unknown id', async (_name, run) => {
    await expect(run(randomUUID())).rejects.toBeInstanceOf(ScheduledNotificationNotFoundError);
  });

  it('a terminal mark FAILS LOUD on a soft-deleted row', async () => {
    const row = await scheduledNotificationFactory({ values: { deletedAt: new Date() } });

    await expect(scheduledNotificationsRepository.markPublished(row.id)).rejects.toBeInstanceOf(
      ScheduledNotificationNotFoundError
    );
  });
});

// ── findByDedupeKey ─────────────────────────────────────────────────────

describe('scheduledNotificationsRepository.findByDedupeKey', () => {
  it('returns live rows for the key across ALL statuses', async () => {
    const dedupeKey = key();
    await scheduledNotificationFactory({ dedupeKey, values: { status: 'published' } });
    await scheduledNotificationFactory({ dedupeKey, values: { status: 'cancelled' } });
    await scheduledNotificationFactory({ dedupeKey }); // pending

    const rows = await scheduledNotificationsRepository.findByDedupeKey(dedupeKey);

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.status))).toEqual(
      new Set(['published', 'cancelled', 'pending'])
    );
  });

  it('excludes soft-deleted rows and other keys', async () => {
    const dedupeKey = key();
    await scheduledNotificationFactory({ dedupeKey, values: { deletedAt: new Date() } });
    await scheduledNotificationFactory(); // a different key

    expect(await scheduledNotificationsRepository.findByDedupeKey(dedupeKey)).toHaveLength(0);
  });
});
