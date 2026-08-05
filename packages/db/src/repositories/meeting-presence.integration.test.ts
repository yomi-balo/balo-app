import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { meetingPresence, meetings, type MeetingParticipantParty } from '../schema';
import { meetingFactory, userFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { meetingPresenceRepository } from './meeting-presence';

const MIN = 60_000;
/**
 * A FIXED PAST instant. Deliberately in the past: `close()` defaults `leftAt` to the real
 * wall clock, and a future `T0` would make that default land BEFORE `joined_at` and trip
 * `meeting_presence_left_after_joined` depending on the hour the suite runs.
 */
const T0 = new Date('2026-07-01T10:00:00.000Z');

/** `T0 + n` minutes. */
function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * MIN);
}

/** `open` at `T0 + minutes`. A one-liner so the presence TIMELINE stays readable. */
async function join(
  meetingId: string,
  userId: string | null,
  party: MeetingParticipantParty,
  minutes: number
): Promise<Awaited<ReturnType<typeof meetingPresenceRepository.open>>> {
  return meetingPresenceRepository.open({ meetingId, userId, party, joinedAt: at(minutes) });
}

/** `close` at `T0 + minutes` (omit `minutes` to exercise the wall-clock default). */
async function leave(
  meetingId: string,
  userId: string | null,
  minutes?: number
): Promise<Awaited<ReturnType<typeof meetingPresenceRepository.close>>> {
  return meetingPresenceRepository.close({
    meetingId,
    userId,
    ...(minutes === undefined ? {} : { leftAt: at(minutes) }),
  });
}

describe('meetingPresenceRepository.open / close', () => {
  it('opens an interval with left_at NULL, then closes it', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();

    const opened = await join(meeting.id, expert.id, 'expert', 0);
    expect(opened.leftAt).toBeNull();
    expect(opened.party).toBe('expert');

    const closed = await leave(meeting.id, expert.id, 30);
    expect(closed?.id).toBe(opened.id);
    expect(closed?.leftAt?.getTime()).toBe(at(30).getTime());
  });

  it('a DUPLICATE open returns the EXISTING open interval (the 23505 guard, idempotent)', async () => {
    const { meeting } = await meetingFactory();
    const client = await userFactory();

    const first = await join(meeting.id, client.id, 'client', 0);
    const second = await join(meeting.id, client.id, 'client', 1);

    // A duplicate join webhook must NOT open a second interval that double-counts a clock.
    expect(second.id).toBe(first.id);
    expect(second.joinedAt.getTime()).toBe(at(0).getTime());
    expect(await meetingPresenceRepository.listByMeeting(meeting.id)).toHaveLength(1);
  });

  it('re-opening AFTER a close creates a genuine SECOND interval (the rejoin)', async () => {
    const { meeting } = await meetingFactory();
    const client = await userFactory();

    const first = await join(meeting.id, client.id, 'client', 0);
    await leave(meeting.id, client.id, 10);
    const second = await join(meeting.id, client.id, 'client', 20);

    expect(second.id).not.toBe(first.id);
    expect(await meetingPresenceRepository.listByMeeting(meeting.id)).toHaveLength(2);
  });

  it('close with NO open interval returns undefined (idempotent duplicate leave webhook)', async () => {
    const { meeting } = await meetingFactory();
    const user = await userFactory();

    expect(await leave(meeting.id, user.id)).toBeUndefined();

    await join(meeting.id, user.id, 'client', 0);
    await leave(meeting.id, user.id, 5);
    expect(await leave(meeting.id, user.id)).toBeUndefined();
  });

  it('CONCURRENT double-close: FIRST CLOSE WINS — the CAS refuses to extend left_at', async () => {
    const { meeting } = await meetingFactory();
    const user = await userFactory();
    const opened = await join(meeting.id, user.id, 'client', 0);

    // Both retried `participant-left` webhooks read the SAME open interval BEFORE either
    // writes — the interleaving the compare-and-set exists to survive.
    const firstView = await meetingPresenceRepository.findOpen(meeting.id, user.id);
    const secondView = await meetingPresenceRepository.findOpen(meeting.id, user.id);
    expect(firstView?.id).toBe(opened.id);
    expect(secondView?.id).toBe(opened.id);

    const early = await leave(meeting.id, user.id, 10);
    // The later writer now matches zero rows and is a genuine no-op. WITHOUT the
    // `isNull(leftAt)` in the update's WHERE, this second call would overwrite `left_at`
    // with 50 — silently extending a SPAN-based billable clock by 40 minutes.
    const late = await leave(meeting.id, user.id, 50);

    expect(early?.leftAt?.getTime()).toBe(at(10).getTime());
    expect(late).toBeUndefined();

    const [persisted] = await db
      .select()
      .from(meetingPresence)
      .where(eq(meetingPresence.id, opened.id));
    expect(persisted?.leftAt?.getTime()).toBe(at(10).getTime());
  });

  it('a GUEST (user_id NULL) opens and closes — documented gap: NOT deduplicated', async () => {
    const { meeting } = await meetingFactory();

    await join(meeting.id, null, 'client', 0);
    await join(meeting.id, null, 'client', 1);

    // NULLs are DISTINCT in `meeting_presence_one_open_per_user_idx`, so a guest is not
    // covered. Asserted so the gap is visible, not accidental — BAL-408/BAL-134 close it.
    expect(await meetingPresenceRepository.listByMeeting(meeting.id)).toHaveLength(2);

    const closed = await leave(meeting.id, null, 5);
    expect(closed?.joinedAt.getTime()).toBe(at(0).getTime()); // the EARLIEST open interval
  });

  it('left_at BEFORE joined_at is rejected (23514); an equal pair is legal (zero-length blip)', async () => {
    const { meeting } = await meetingFactory();
    const user = await userFactory();

    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingPresence).values({
        meetingId: meeting.id,
        userId: user.id,
        party: 'expert',
        joinedAt: at(10),
        leftAt: at(9),
      })
    );

    const [blip] = await db
      .insert(meetingPresence)
      .values({
        meetingId: meeting.id,
        userId: user.id,
        party: 'expert',
        joinedAt: at(10),
        leftAt: at(10),
      })
      .returning();
    expect(blip?.leftAt?.getTime()).toBe(at(10).getTime());
  });
});

describe('meetingPresenceRepository.clocks', () => {
  it('THE AC REJOIN CASE — a client drop+rejoin yields ONE continuous billable span', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    const client = await userFactory();

    // Expert 0 → 40. Client 5 → 15, drops, rejoins 25 → 35.
    await join(meeting.id, expert.id, 'expert', 0);
    await join(meeting.id, client.id, 'client', 5);
    await leave(meeting.id, client.id, 15);
    await join(meeting.id, client.id, 'client', 25);
    await leave(meeting.id, client.id, 35);
    await leave(meeting.id, expert.id, 40);

    const clocks = await meetingPresenceRepository.clocks(meeting.id, at(60));

    // A SUM would be 10 + 10 = 20 min — under-billing the call by the 10-min gap. The
    // SPAN is 5 → 35 = 30 min, gap INCLUSIVE. The timer never restarted.
    expect(clocks.billableMs).toBe(30 * MIN);
    expect(clocks.billableStartedAt?.getTime()).toBe(at(5).getTime());
    expect(clocks.expertPresentMs).toBe(40 * MIN);
    expect(clocks.expertFirstJoinedAt?.getTime()).toBe(at(0).getTime());
  });

  it('an EXPERT drop+rejoin does not move the first-join anchor or restart the clock', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    const client = await userFactory();

    // Expert 0 → 10, drops, rejoins 20 → 30. Client 2 → 28 throughout.
    await join(meeting.id, expert.id, 'expert', 0);
    await leave(meeting.id, expert.id, 10);
    await join(meeting.id, expert.id, 'expert', 20);
    await leave(meeting.id, expert.id, 30);
    await join(meeting.id, client.id, 'client', 2);
    await leave(meeting.id, client.id, 28);

    const clocks = await meetingPresenceRepository.clocks(meeting.id, at(60));

    expect(clocks.expertFirstJoinedAt?.getTime()).toBe(at(0).getTime());
    expect(clocks.expertPresentMs).toBe(30 * MIN); // 0 → 30, gap inclusive
    expect(clocks.billableMs).toBe(26 * MIN); // 2 → 28, gap inclusive
  });

  it('expert-only, no client ever ⇒ billableMs 0 with a running expert clock (the no-show input)', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();

    await join(meeting.id, expert.id, 'expert', 0);
    await leave(meeting.id, expert.id, 15);

    const clocks = await meetingPresenceRepository.clocks(meeting.id, at(60));

    expect(clocks.expertPresentMs).toBe(15 * MIN);
    expect(clocks.billableMs).toBe(0);
    expect(clocks.billableStartedAt).toBeNull();
  });

  it('an OBSERVER never makes a meeting billable', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    const staffer = await userFactory();

    await join(meeting.id, expert.id, 'expert', 0);
    await join(meeting.id, staffer.id, 'observer', 0);
    await leave(meeting.id, staffer.id, 20);
    await leave(meeting.id, expert.id, 20);

    const clocks = await meetingPresenceRepository.clocks(meeting.id, at(60));

    expect(clocks.expertPresentMs).toBe(20 * MIN);
    expect(clocks.billableMs).toBe(0);
    expect(clocks.billableStartedAt).toBeNull();
  });

  it('an OPEN interval runs to `now`', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    const client = await userFactory();

    await join(meeting.id, expert.id, 'expert', 0);
    await join(meeting.id, client.id, 'client', 5);

    const clocks = await meetingPresenceRepository.clocks(meeting.id, at(25));

    expect(clocks.expertPresentMs).toBe(25 * MIN);
    expect(clocks.billableMs).toBe(20 * MIN);
  });

  it('is QUERYABLE AFTER THE MEETING ENDS (BAL-412 settlement reads durable rows)', async () => {
    const { meeting } = await meetingFactory({
      values: { status: 'ended', outcome: 'completed', endedAt: at(40) },
    });
    const expert = await userFactory();
    const client = await userFactory();

    await join(meeting.id, expert.id, 'expert', 0);
    await join(meeting.id, client.id, 'client', 3);
    await leave(meeting.id, client.id, 38);
    await leave(meeting.id, expert.id, 40);

    // The meeting is terminal — presence is still a durable BILLING input, not room state.
    const clocks = await meetingPresenceRepository.clocks(meeting.id, at(600));
    expect(clocks.expertPresentMs).toBe(40 * MIN);
    expect(clocks.billableMs).toBe(35 * MIN);
    expect(await meetingPresenceRepository.listByMeeting(meeting.id)).toHaveLength(2);
  });

  it('a SOFT-DELETED interval is excluded from both the list and the clocks', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    const client = await userFactory();

    const expertInterval = await join(meeting.id, expert.id, 'expert', 0);
    await leave(meeting.id, expert.id, 20);
    await join(meeting.id, client.id, 'client', 5);
    await leave(meeting.id, client.id, 15);

    await db
      .update(meetingPresence)
      .set({ deletedAt: new Date() })
      .where(eq(meetingPresence.id, expertInterval.id));

    const clocks = await meetingPresenceRepository.clocks(meeting.id, at(60));
    expect(await meetingPresenceRepository.listByMeeting(meeting.id)).toHaveLength(1);
    expect(clocks.expertPresentMs).toBe(0);
    expect(clocks.billableMs).toBe(0);
  });

  // ── The DEFAULT `now` (no explicit argument) — previously untested ───────────────────
  it('DROPPED LEAVE WEBHOOKS: an ended meeting measures open intervals to ended_at, NOT the wall clock', async () => {
    // The call really ran 0 → 30 and ended there, but BOTH `participant-left` webhooks
    // were lost, so both intervals are still open. `T0` is over a month in the past, so a
    // wall-clock ceiling would report ~weeks of billable time instead of 30 minutes.
    const { meeting } = await meetingFactory({
      values: { status: 'ended', outcome: 'completed', endedAt: at(30) },
    });
    const expert = await userFactory();
    const client = await userFactory();

    await join(meeting.id, expert.id, 'expert', 0);
    await join(meeting.id, client.id, 'client', 2);

    // NO explicit `now` — this is exactly how a settlement job would call it.
    const clocks = await meetingPresenceRepository.clocks(meeting.id);

    expect(clocks.expertPresentMs).toBe(30 * MIN);
    expect(clocks.billableMs).toBe(28 * MIN);
    // Guard against a false pass: the wall clock is months past T0, so a regression to
    // `new Date()` would blow way past a whole day of billable time.
    expect(clocks.billableMs).toBeLessThan(24 * 60 * MIN);
  });

  it('a RUNNING meeting still measures open intervals to the wall clock (BAL-403 in-session)', async () => {
    // Not terminal ⇒ "to now" is the correct, wanted behaviour: an in-session panel must
    // see the clock advancing. Joins are anchored to the real clock so the assertion is
    // about the ceiling, not about T0.
    const { meeting } = await meetingFactory(); // status defaults to 'scheduled'
    const expert = await userFactory();
    const client = await userFactory();
    const tenMinutesAgo = new Date(Date.now() - 10 * MIN);

    await meetingPresenceRepository.open({
      meetingId: meeting.id,
      userId: expert.id,
      party: 'expert',
      joinedAt: tenMinutesAgo,
    });
    await meetingPresenceRepository.open({
      meetingId: meeting.id,
      userId: client.id,
      party: 'client',
      joinedAt: tenMinutesAgo,
    });

    const clocks = await meetingPresenceRepository.clocks(meeting.id);

    expect(clocks.billableMs).toBeGreaterThanOrEqual(10 * MIN);
    expect(clocks.billableMs).toBeLessThan(11 * MIN);
  });

  it('an ENDED meeting with a NULL ended_at falls back to the wall clock (BAL-134 must stamp it)', async () => {
    // The documented residual: this ticket owns no transition logic, so it will not invent
    // a ceiling from `scheduled_end`. Pinned as a test so the gap is a KNOWN, asserted
    // behaviour rather than a surprise — BAL-134 closes it by stamping `ended_at` in the
    // same statement that sets `status='ended'`.
    const { meeting } = await meetingFactory({ values: { status: 'ended' } });
    const expert = await userFactory();
    const client = await userFactory();
    const fiveMinutesAgo = new Date(Date.now() - 5 * MIN);

    await meetingPresenceRepository.open({
      meetingId: meeting.id,
      userId: expert.id,
      party: 'expert',
      joinedAt: fiveMinutesAgo,
    });
    await meetingPresenceRepository.open({
      meetingId: meeting.id,
      userId: client.id,
      party: 'client',
      joinedAt: fiveMinutesAgo,
    });

    const clocks = await meetingPresenceRepository.clocks(meeting.id);
    expect(clocks.billableMs).toBeGreaterThanOrEqual(5 * MIN);
    expect(clocks.billableMs).toBeLessThan(6 * MIN);
  });

  it('an explicit `now` always overrides the resolved ceiling', async () => {
    const { meeting } = await meetingFactory({
      values: { status: 'ended', outcome: 'completed', endedAt: at(30) },
    });
    const expert = await userFactory();
    const client = await userFactory();
    await join(meeting.id, expert.id, 'expert', 0);
    await join(meeting.id, client.id, 'client', 0);

    // ended_at is at(30), but the caller asks for the clocks as at minute 12.
    const clocks = await meetingPresenceRepository.clocks(meeting.id, at(12));
    expect(clocks.billableMs).toBe(12 * MIN);
  });

  it('a meeting with no presence at all reports zeroed clocks and null anchors', async () => {
    const { meeting } = await meetingFactory();

    expect(await meetingPresenceRepository.clocks(meeting.id, at(60))).toEqual({
      expertPresentMs: 0,
      billableMs: 0,
      expertFirstJoinedAt: null,
      billableStartedAt: null,
    });
  });
});

describe('meeting_presence — FK behaviour', () => {
  it('a HARD-deleted meeting cascades its presence rows away (ON DELETE cascade)', async () => {
    // `contexts: []` so the delete is not blocked by anything else; `meetingsRepository`
    // exposes only a SOFT delete (a hard delete is not a product operation), so the
    // cascade is asserted with a raw drizzle delete — the transcripts-cascade precedent.
    const { meeting } = await meetingFactory({ contexts: [] });
    const user = await userFactory();
    await join(meeting.id, user.id, 'expert', 0);

    await db.delete(meetings).where(eq(meetings.id, meeting.id));

    const rows = await db
      .select()
      .from(meetingPresence)
      .where(eq(meetingPresence.meetingId, meeting.id));
    expect(rows).toHaveLength(0);
  });
});
