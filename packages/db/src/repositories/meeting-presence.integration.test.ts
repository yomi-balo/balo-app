import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import {
  meetingContexts,
  meetingPresence,
  meetings,
  type MeetingParticipantParty,
} from '../schema';
import {
  engagementFactory,
  meetingFactory,
  meetingGuestFactory,
  userFactory,
} from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import {
  InvalidPresenceIdentityError,
  InvalidPresenceTimestampError,
  meetingPresenceRepository,
} from './meeting-presence';

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

/** `open` at `T0 + minutes` for an AUTHENTICATED (or unmapped, `userId: null`) participant. */
async function join(
  meetingId: string,
  userId: string | null,
  party: MeetingParticipantParty,
  minutes: number
): Promise<Awaited<ReturnType<typeof meetingPresenceRepository.open>>> {
  return meetingPresenceRepository.open({
    meetingId,
    userId,
    meetingGuestId: null,
    party,
    joinedAt: at(minutes),
  });
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
    meetingGuestId: null,
    ...(minutes === undefined ? {} : { leftAt: at(minutes) }),
  });
}

/** BAL-408/BAL-134 — `open` at `T0 + minutes` for a token-authenticated GUEST. */
async function guestJoin(
  meetingId: string,
  meetingGuestId: string,
  party: MeetingParticipantParty,
  minutes: number
): Promise<Awaited<ReturnType<typeof meetingPresenceRepository.open>>> {
  return meetingPresenceRepository.open({
    meetingId,
    userId: null,
    meetingGuestId,
    party,
    joinedAt: at(minutes),
  });
}

/** BAL-408/BAL-134 — `close` at `T0 + minutes` for a token-authenticated GUEST. */
async function guestLeave(
  meetingId: string,
  meetingGuestId: string,
  minutes?: number
): Promise<Awaited<ReturnType<typeof meetingPresenceRepository.close>>> {
  return meetingPresenceRepository.close({
    meetingId,
    userId: null,
    meetingGuestId,
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
    const identity = { userId: user.id, meetingGuestId: null };
    const firstView = await meetingPresenceRepository.findOpen(meeting.id, identity);
    const secondView = await meetingPresenceRepository.findOpen(meeting.id, identity);
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

  it('an UNMAPPED participant (BOTH identity columns NULL) is still NOT deduplicated — the irreducible residue', async () => {
    const { meeting } = await meetingFactory();

    await join(meeting.id, null, 'observer', 0);
    await join(meeting.id, null, 'observer', 1);

    // ⚠ THIS TEST USED TO BE ABOUT GUESTS. BAL-408 + BAL-134 CLOSED THAT GAP (see the
    // guest-identity describe block below); what remains is the ONE class that cannot be
    // deduplicated at all — a Daily participant the writer could map to neither a user nor a
    // `meeting_guests` row. NULLs are distinct in a unique index and there is no other key to
    // arbitrate on, so each observation opens a fresh interval. Irreducible, not an oversight.
    //
    // And it is the SAFE side of the trade: such a participant is written `party='observer'`,
    // which `computeMeetingClocks` excludes from BOTH sides of the billable intersection — so
    // a duplicated one bills nothing (asserted below, not merely asserted in prose).
    expect(await meetingPresenceRepository.listByMeeting(meeting.id)).toHaveLength(2);

    const closed = await leave(meeting.id, null, 5);
    expect(closed?.joinedAt.getTime()).toBe(at(0).getTime()); // the EARLIEST open interval

    const clocks = await meetingPresenceRepository.clocks(meeting.id, at(60));
    expect(clocks.billableMs).toBe(0);
    expect(clocks.expertPresentMs).toBe(0);
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

// ── BAL-408 / BAL-134: GUEST IDENTITY — the gap BAL-418 documented and assigned here ───────

describe('meetingPresenceRepository — guest identity', () => {
  it('THE CLOSED GAP: a DUPLICATE guest join returns the EXISTING interval, not a second one', async () => {
    const { meeting } = await meetingFactory();
    const { guest } = await meetingGuestFactory({ meetingId: meeting.id });

    const first = await guestJoin(meeting.id, guest.id, 'client', 0);
    const second = await guestJoin(meeting.id, guest.id, 'client', 1);

    // ⚠ THE 42P10 CANARY. This upsert's arbiter must restate
    // `meeting_presence_one_open_per_guest_idx`'s predicate byte-for-byte, with no bind
    // parameters, or Postgres cannot prove implication and the INSERT fails
    // `42P10 there is no unique or exclusion constraint matching the ON CONFLICT
    // specification`. A wrong arbiter fails LOUDLY here and NOWHERE ELSE — no typecheck, no
    // unit test and no lint rule can see it.
    expect(second.id).toBe(first.id);
    expect(second.joinedAt.getTime()).toBe(at(0).getTime());
    expect(await meetingPresenceRepository.listByMeeting(meeting.id)).toHaveLength(1);
  });

  it('writes meeting_guest_id and leaves user_id NULL (the identity CHECK’s guest shape)', async () => {
    const { meeting } = await meetingFactory();
    const { guest } = await meetingGuestFactory({ meetingId: meeting.id });

    const opened = await guestJoin(meeting.id, guest.id, 'client', 0);

    expect(opened.meetingGuestId).toBe(guest.id);
    expect(opened.userId).toBeNull();
  });

  it('TWO DIFFERENT guests on one meeting are NOT collapsed into one interval', async () => {
    const { meeting } = await meetingFactory();
    const { guest: first } = await meetingGuestFactory({ meetingId: meeting.id });
    const { guest: second } = await meetingGuestFactory({ meetingId: meeting.id });

    // The unique is on the PAIR `(meeting_id, meeting_guest_id)`. An arbiter keyed on
    // `meeting_id` alone would silently drop the second attendee's whole presence record.
    await guestJoin(meeting.id, first.id, 'client', 0);
    await guestJoin(meeting.id, second.id, 'client', 1);

    expect(await meetingPresenceRepository.listByMeeting(meeting.id)).toHaveLength(2);
  });

  it('a guest REJOIN after a close opens a genuine second interval', async () => {
    const { meeting } = await meetingFactory();
    const { guest } = await meetingGuestFactory({ meetingId: meeting.id });

    const first = await guestJoin(meeting.id, guest.id, 'client', 0);
    await guestLeave(meeting.id, guest.id, 10);
    const second = await guestJoin(meeting.id, guest.id, 'client', 20);

    // The partial unique constrains OPEN intervals only, so a rejoin is legal — and the
    // clocks stay SPANS, so the gap sits inside the billable window rather than restarting it.
    expect(second.id).not.toBe(first.id);
    expect(await meetingPresenceRepository.listByMeeting(meeting.id)).toHaveLength(2);
  });

  it('close routes on the GUEST key — a guest and a user on one meeting never close each other', async () => {
    const { meeting } = await meetingFactory();
    const { guest } = await meetingGuestFactory({ meetingId: meeting.id });
    const expert = await userFactory();

    await join(meeting.id, expert.id, 'expert', 0);
    await guestJoin(meeting.id, guest.id, 'client', 0);

    const closedGuest = await guestLeave(meeting.id, guest.id, 10);
    expect(closedGuest?.meetingGuestId).toBe(guest.id);

    // The expert's interval must be untouched — closing the wrong side's interval would
    // truncate the billable span against the wrong party.
    const stillOpen = await meetingPresenceRepository.findOpen(meeting.id, {
      userId: expert.id,
      meetingGuestId: null,
    });
    expect(stillOpen?.leftAt).toBeNull();
  });

  it('⚠ AN UNMAPPED close must NOT reach a GUEST’s interval (the `user_id IS NULL` trap)', async () => {
    const { meeting } = await meetingFactory();
    const { guest } = await meetingGuestFactory({ meetingId: meeting.id });

    const guestInterval = await guestJoin(meeting.id, guest.id, 'client', 0);

    // Before guest identity existed, a null `userId` matched on `user_id IS NULL` ALONE — which
    // now matches every guest row too. Closing "the unmapped participant" would then truncate an
    // arbitrary REAL attendee's billable span. `identityMatches` constrains BOTH columns on this
    // arm, so the close finds nothing.
    expect(await leave(meeting.id, null, 5)).toBeUndefined();

    const [persisted] = await db
      .select()
      .from(meetingPresence)
      .where(eq(meetingPresence.id, guestInterval.id));
    expect(persisted?.leftAt).toBeNull();
  });

  it('a client-side guest DOES anchor the billable clock; an expert-side one must be written observer', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    const { guest: clientGuest } = await meetingGuestFactory({ meetingId: meeting.id });
    const { guest: agencyColleague } = await meetingGuestFactory({ meetingId: meeting.id });

    await join(meeting.id, expert.id, 'expert', 0);
    // `presencePartyForGuest` (the caller's obligation, `@balo/shared/meetings`) maps
    // `client → client` and `expert → observer`. Written here as the two values that function
    // produces, so the BILLING consequence of the mapping is pinned at the storage layer too.
    await guestJoin(meeting.id, clientGuest.id, 'client', 10);
    await guestJoin(meeting.id, agencyColleague.id, 'observer', 0);
    await leave(meeting.id, expert.id, 40);

    const clocks = await meetingPresenceRepository.clocks(meeting.id, at(40));

    // The billable span anchors on the CLIENT-side guest at minute 10, NOT on the expert-side
    // one at minute 0 — an agency colleague must never put a non-delivering attendee on the
    // billable clock ("per-minute of expert time, never per-seat").
    expect(clocks.billableStartedAt?.getTime()).toBe(at(10).getTime());
    expect(clocks.billableMs).toBe(30 * MIN);
  });

  it('rejects BOTH identity columns being set, in-process, before the CHECK sees it', async () => {
    const { meeting } = await meetingFactory();
    const { guest } = await meetingGuestFactory({ meetingId: meeting.id });
    const user = await userFactory();

    await expect(
      meetingPresenceRepository.open({
        meetingId: meeting.id,
        userId: user.id,
        meetingGuestId: guest.id,
        party: 'client',
        joinedAt: at(0),
      })
    ).rejects.toThrow(InvalidPresenceIdentityError);

    // Nothing was written — the guard runs before the insert, so `meeting_presence_identity_
    // not_both` never has to fire.
    expect(await meetingPresenceRepository.listByMeeting(meeting.id)).toHaveLength(0);
  });
});

// ── BAL-134 (R10): the WRITE-SIDE window clamp ─────────────────────────────────────────────

describe('meetingPresenceRepository — the R10 write-side clamp', () => {
  /** A meeting window of `T0 → T0 + 60`, plus the generous 24h post-end tolerance. */
  const WINDOW = { notBefore: at(0), notAfter: at(60 + 24 * 60) };

  it('THE TICKET RULE: an expert arriving at 09:55 for a 10:00 call is not credited for arriving early', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();

    const opened = await meetingPresenceRepository.open({
      meetingId: meeting.id,
      userId: expert.id,
      meetingGuestId: null,
      party: 'expert',
      joinedAt: at(-5), // 09:55 for a 10:00 call
      window: WINDOW,
    });

    expect(opened.joinedAt.getTime()).toBe(at(0).getTime());
  });

  it('leaves a join INSIDE the window exactly as given', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();

    const opened = await meetingPresenceRepository.open({
      meetingId: meeting.id,
      userId: expert.id,
      meetingGuestId: null,
      party: 'expert',
      joinedAt: at(7),
      window: WINDOW,
    });

    expect(opened.joinedAt.getTime()).toBe(at(7).getTime());
  });

  it('lowers a nonsense far-future leave to the window ceiling', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    await meetingPresenceRepository.open({
      meetingId: meeting.id,
      userId: expert.id,
      meetingGuestId: null,
      party: 'expert',
      joinedAt: at(0),
      window: WINDOW,
    });

    const closed = await meetingPresenceRepository.close({
      meetingId: meeting.id,
      userId: expert.id,
      meetingGuestId: null,
      leftAt: at(10 * 24 * 60), // ten days later — a dropped-then-resurrected webhook
      window: WINDOW,
    });

    expect(closed?.leftAt?.getTime()).toBe(WINDOW.notAfter.getTime());
  });

  it('does NOT truncate a legitimately OVER-RUNNING call (the ceiling is generous on purpose)', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    const client = await userFactory();
    await meetingPresenceRepository.open({
      meetingId: meeting.id,
      userId: expert.id,
      meetingGuestId: null,
      party: 'expert',
      joinedAt: at(0),
      window: WINDOW,
    });
    await meetingPresenceRepository.open({
      meetingId: meeting.id,
      userId: client.id,
      meetingGuestId: null,
      party: 'client',
      joinedAt: at(0),
      window: WINDOW,
    });

    // 75 minutes on a 60-minute booking. Nothing terminates on `scheduled_end` (edge case 20),
    // and truncating here would be a silent UNDER-bill; the settlement-side policy cap is
    // BAL-412's `effectiveCeilingMinor`, not this clamp's job.
    await meetingPresenceRepository.close({
      meetingId: meeting.id,
      userId: client.id,
      meetingGuestId: null,
      leftAt: at(75),
      window: WINDOW,
    });
    await meetingPresenceRepository.close({
      meetingId: meeting.id,
      userId: expert.id,
      meetingGuestId: null,
      leftAt: at(75),
      window: WINDOW,
    });

    const clocks = await meetingPresenceRepository.clocks(meeting.id, at(120));
    expect(clocks.billableMs).toBe(75 * MIN);
  });

  it('DEGRADES TO A ZERO-LENGTH INTERVAL when the clamped leave lands below its own join', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();

    // Joined 09:55 → clamped UP to 10:00. Left 09:58 → below its own stored `joined_at`.
    // A bare write would trip `meeting_presence_left_after_joined` with 23514; the clamp
    // raises it to `joined_at` instead, which is legal (the CHECK is `>=`) and bills nothing.
    await meetingPresenceRepository.open({
      meetingId: meeting.id,
      userId: expert.id,
      meetingGuestId: null,
      party: 'expert',
      joinedAt: at(-5),
      window: WINDOW,
    });

    const closed = await meetingPresenceRepository.close({
      meetingId: meeting.id,
      userId: expert.id,
      meetingGuestId: null,
      leftAt: at(-2),
      window: WINDOW,
    });

    expect(closed?.joinedAt.getTime()).toBe(at(0).getTime());
    expect(closed?.leftAt?.getTime()).toBe(at(0).getTime());
    expect(await meetingPresenceRepository.clocks(meeting.id, at(60))).toMatchObject({
      expertPresentMs: 0,
      billableMs: 0,
    });
  });

  it('WITHOUT a window nothing is clamped, and an inverted pair still raises 23514 loudly', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();

    // The clamp is OPT-IN. Fixtures and backfills must be able to store an instant exactly as
    // given — and a caller bug on the un-clamped path must stay loud rather than being
    // silently rewritten by the repository.
    const opened = await join(meeting.id, expert.id, 'expert', -5);
    expect(opened.joinedAt.getTime()).toBe(at(-5).getTime());

    await expectConstraintViolation('23514', (tx) =>
      tx
        .update(meetingPresence)
        .set({ leftAt: at(-10) })
        .where(eq(meetingPresence.id, opened.id))
    );
  });

  it('rejects a NON-FINITE joinedAt / leftAt at the write seam (the obligation named on computeMeetingClocks)', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();

    // An Invalid Date's getTime() is NaN, every comparison against it is FALSE, and it would
    // therefore slip past `left_at >= joined_at` too — poisoning every clock read of this
    // meeting forever. Loud and early, at the one door it can enter through.
    await expect(
      meetingPresenceRepository.open({
        meetingId: meeting.id,
        userId: expert.id,
        meetingGuestId: null,
        party: 'expert',
        joinedAt: new Date('not-a-date'),
      })
    ).rejects.toThrow(InvalidPresenceTimestampError);

    await join(meeting.id, expert.id, 'expert', 0);
    await expect(
      meetingPresenceRepository.close({
        meetingId: meeting.id,
        userId: expert.id,
        meetingGuestId: null,
        leftAt: new Date(Number.NaN),
      })
    ).rejects.toThrow(InvalidPresenceTimestampError);

    // Nothing was written by the rejected open, and the rejected close left the interval open.
    const rows = await meetingPresenceRepository.listByMeeting(meeting.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.leftAt).toBeNull();
  });

  it('rejects a NON-FINITE window bound rather than clamping to nonsense', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();

    await expect(
      meetingPresenceRepository.open({
        meetingId: meeting.id,
        userId: expert.id,
        meetingGuestId: null,
        party: 'expert',
        joinedAt: at(0),
        window: { notBefore: new Date(Number.NaN), notAfter: at(60) },
      })
    ).rejects.toThrow(InvalidPresenceTimestampError);
  });
});

// ── BAL-134: closeAllOpen + listOpen ───────────────────────────────────────────────────────

describe('meetingPresenceRepository.closeAllOpen / listOpen', () => {
  it('closes EVERY open interval in one statement and reports how many', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    const client = await userFactory();
    const { guest } = await meetingGuestFactory({ meetingId: meeting.id });

    await join(meeting.id, expert.id, 'expert', 0);
    await join(meeting.id, client.id, 'client', 5);
    await guestJoin(meeting.id, guest.id, 'client', 6);

    // Both identity kinds are closed by the SAME statement — it keys on the meeting, not on
    // any identity, which is what makes it a complete "the room is empty now" sweep.
    const closed = await meetingPresenceRepository.closeAllOpen(meeting.id, at(30));
    expect(closed).toBe(3);
    expect(await meetingPresenceRepository.listOpen(meeting.id)).toHaveLength(0);

    const rows = await meetingPresenceRepository.listByMeeting(meeting.id);
    expect(rows.map((row) => row.leftAt?.getTime())).toEqual([
      at(30).getTime(),
      at(30).getTime(),
      at(30).getTime(),
    ]);
  });

  it('is IDEMPOTENT: a second call closes nothing and never extends an existing left_at', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    await join(meeting.id, expert.id, 'expert', 0);

    expect(await meetingPresenceRepository.closeAllOpen(meeting.id, at(30))).toBe(1);
    // The `left_at IS NULL` filter IS the compare-and-set. Without it, a second terminal
    // transition (or a `meeting.ended` webhook arriving after one) would push `left_at`
    // forward and extend a SPAN-based billable clock.
    expect(await meetingPresenceRepository.closeAllOpen(meeting.id, at(90))).toBe(0);

    const rows = await meetingPresenceRepository.listByMeeting(meeting.id);
    expect(rows[0]?.leftAt?.getTime()).toBe(at(30).getTime());
  });

  it('⚠ GREATEST(joined_at, leftAt): an end BEFORE a clamped join degrades, it does not 23514', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();

    // The real sequence: the expert joined at 09:55, the R10 clamp stored `joined_at = 10:00`,
    // and then somebody ended the call at 09:58. A bare `SET left_at = $endedAt` writes
    // `left_at < joined_at`, trips the CHECK, and — inside `endMeeting`'s transaction — rolls
    // back the WHOLE termination, leaving the meeting un-endable by that path forever.
    const opened = await meetingPresenceRepository.open({
      meetingId: meeting.id,
      userId: expert.id,
      meetingGuestId: null,
      party: 'expert',
      joinedAt: at(-5),
      window: { notBefore: at(0), notAfter: at(60) },
    });
    expect(opened.joinedAt.getTime()).toBe(at(0).getTime());

    const closed = await meetingPresenceRepository.closeAllOpen(meeting.id, at(-2));
    expect(closed).toBe(1);

    const rows = await meetingPresenceRepository.listByMeeting(meeting.id);
    expect(rows[0]?.leftAt?.getTime()).toBe(at(0).getTime()); // raised to its own joined_at
  });

  it('touches neither ALREADY-CLOSED nor SOFT-DELETED nor OTHER meetings’ intervals', async () => {
    const { meeting } = await meetingFactory();
    const other = await meetingFactory();
    const closedUser = await userFactory();
    const deletedUser = await userFactory();
    const openUser = await userFactory();
    const otherUser = await userFactory();

    await join(meeting.id, closedUser.id, 'client', 0);
    await leave(meeting.id, closedUser.id, 10);
    const softDeleted = await join(meeting.id, deletedUser.id, 'client', 0);
    await db
      .update(meetingPresence)
      .set({ deletedAt: new Date() })
      .where(eq(meetingPresence.id, softDeleted.id));
    await join(meeting.id, openUser.id, 'expert', 0);
    await join(other.meeting.id, otherUser.id, 'expert', 0);

    // Exactly ONE: the live open interval. Not the already-closed one (its `left_at` must not
    // be pushed forward), not the soft-deleted one, and not the other meeting's.
    expect(await meetingPresenceRepository.closeAllOpen(meeting.id, at(30))).toBe(1);

    const [softDeletedRow] = await db
      .select()
      .from(meetingPresence)
      .where(eq(meetingPresence.id, softDeleted.id));
    expect(softDeletedRow?.leftAt).toBeNull(); // soft-deleted rows are invisible to the sweep

    const live = await meetingPresenceRepository.listByMeeting(meeting.id);
    const closedEarly = live.find((row) => row.userId === closedUser.id);
    expect(closedEarly?.leftAt?.getTime()).toBe(at(10).getTime());

    expect(await meetingPresenceRepository.listOpen(other.meeting.id)).toHaveLength(1);
  });

  it('returns 0 for a meeting with no open intervals at all', async () => {
    const { meeting } = await meetingFactory();
    expect(await meetingPresenceRepository.closeAllOpen(meeting.id, at(30))).toBe(0);
  });

  it('COMPOSES ON A CALLER’S TRANSACTION, and rolls back with it', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    await join(meeting.id, expert.id, 'expert', 0);

    // This is the property `endMeeting` depends on: presence closure and the status flip are
    // ONE atomic unit, so a terminal meeting can never be observed with an open interval.
    // Nested `db.transaction` inside the harness produces a SAVEPOINT, so the throw rolls back
    // just this block and the per-test transaction survives.
    await expect(
      db.transaction(async (tx) => {
        const closed = await meetingPresenceRepository.closeAllOpen(meeting.id, at(30), tx);
        expect(closed).toBe(1);
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    expect(await meetingPresenceRepository.listOpen(meeting.id)).toHaveLength(1);
  });

  it('listOpen returns only OPEN live intervals, in join order', async () => {
    const { meeting } = await meetingFactory();
    const early = await userFactory();
    const late = await userFactory();
    const gone = await userFactory();

    await join(meeting.id, late.id, 'client', 20);
    await join(meeting.id, early.id, 'expert', 0);
    await join(meeting.id, gone.id, 'observer', 5);
    await leave(meeting.id, gone.id, 10);

    // The reconciler's read (D1 leg 2): whatever this returns that Daily's roster does not
    // confirm is a DROPPED `participant.left`.
    const open = await meetingPresenceRepository.listOpen(meeting.id);
    expect(open.map((row) => row.userId)).toEqual([early.id, late.id]);
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

  it('DOCBLOCK PIN — the dropped-webhook over-bill is 16 HOURS (anchored at the join), not 15.5', async () => {
    // `resolveClockCeiling`'s worked example, EXECUTED so the number cannot drift: a prose
    // example that was never run shipped the wrong number once already. The call really ran
    // 10:00 → 10:30 but BOTH `participant-left` webhooks were lost, so both intervals are
    // still open. A settlement job at 02:00 the next morning measures the SPAN from the
    // FIRST both-present instant — the 10:00 JOIN — to that ceiling: SIXTEEN hours. 15.5h
    // would be the overshoot PAST the true 10:30 end, which is not what the clock measures.
    // The 02:00 wall clock is supplied explicitly because the real one moves; the ceiling
    // `resolveClockCeiling` actually resolves for a terminal meeting is asserted after it.
    const { meeting } = await meetingFactory({
      values: { status: 'ended', outcome: 'completed', endedAt: at(30) },
    });
    const expert = await userFactory();
    const client = await userFactory();

    await join(meeting.id, expert.id, 'expert', 0);
    await join(meeting.id, client.id, 'client', 0);

    // T0 is 10:00, so 02:00 the next morning is T0 + 16h — pinned, not assumed.
    const twoAmNextMorning = at(16 * 60);
    expect(twoAmNextMorning.toISOString()).toBe('2026-07-02T02:00:00.000Z');

    const wallClockCeiling = await meetingPresenceRepository.clocks(meeting.id, twoAmNextMorning);
    expect(wallClockCeiling.billableMs).toBe(16 * 60 * MIN);
    // The anchor is the 10:00 JOIN, not the 10:30 end — that is WHY it is 16h and not 15.5h.
    expect(wallClockCeiling.billableStartedAt).toEqual(at(0));

    // What the repository does instead: `ended_at` is the ceiling ⇒ the true 30 minutes.
    const settlementCeiling = await meetingPresenceRepository.clocks(meeting.id);
    expect(settlementCeiling.billableMs).toBe(30 * MIN);
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
      meetingGuestId: null,
      party: 'expert',
      joinedAt: tenMinutesAgo,
    });
    await meetingPresenceRepository.open({
      meetingId: meeting.id,
      userId: client.id,
      meetingGuestId: null,
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
      meetingGuestId: null,
      party: 'expert',
      joinedAt: fiveMinutesAgo,
    });
    await meetingPresenceRepository.open({
      meetingId: meeting.id,
      userId: client.id,
      meetingGuestId: null,
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

// ── BAL-390: the participation-derived nudge recipient source ────────────────

describe('meetingPresenceRepository.listClientUserIdsForEngagement', () => {
  /** A meeting whose single context is a `case` over a fresh engagement. */
  async function seedCaseMeeting(): Promise<{ meetingId: string; engagementId: string }> {
    const seeded = await meetingFactory();
    if (seeded.caseEngagementId === undefined) {
      throw new Error('expected the default case context');
    }
    return { meetingId: seeded.meeting.id, engagementId: seeded.caseEngagementId };
  }

  it('returns the DISTINCT client-side attendees of an engagement’s meetings', async () => {
    const { meetingId, engagementId } = await seedCaseMeeting();
    const alex = await userFactory();
    const dana = await userFactory();

    await join(meetingId, alex.id, 'client', 0);
    await join(meetingId, dana.id, 'client', 5);

    const ids = await meetingPresenceRepository.listClientUserIdsForEngagement(engagementId);
    expect(ids.sort()).toEqual([alex.id, dana.id].sort());
  });

  it('de-duplicates a client who joined, left, and rejoined the same meeting', async () => {
    const { meetingId, engagementId } = await seedCaseMeeting();
    const alex = await userFactory();

    await join(meetingId, alex.id, 'client', 0);
    await leave(meetingId, alex.id, 10);
    await join(meetingId, alex.id, 'client', 20);

    await expect(
      meetingPresenceRepository.listClientUserIdsForEngagement(engagementId)
    ).resolves.toEqual([alex.id]);
  });

  it('EXCLUDES the expert and observers — the delivering expert must never be nudged to review themselves', async () => {
    const { meetingId, engagementId } = await seedCaseMeeting();
    const expert = await userFactory();
    const staffer = await userFactory();
    const client = await userFactory();

    await join(meetingId, expert.id, 'expert', 0);
    await join(meetingId, staffer.id, 'observer', 1);
    await join(meetingId, client.id, 'client', 2);

    await expect(
      meetingPresenceRepository.listClientUserIdsForEngagement(engagementId)
    ).resolves.toEqual([client.id]);
  });

  it('EXCLUDES a guest (user_id IS NULL) — guests hold no capability and cannot own a review', async () => {
    const { meetingId, engagementId } = await seedCaseMeeting();
    const client = await userFactory();

    await join(meetingId, null, 'client', 0);
    await join(meetingId, client.id, 'client', 1);

    await expect(
      meetingPresenceRepository.listClientUserIdsForEngagement(engagementId)
    ).resolves.toEqual([client.id]);
  });

  it('excludes soft-deleted presence rows, meetings, and context rows', async () => {
    const softPresence = await seedCaseMeeting();
    const presenceUser = await userFactory();
    const opened = await join(softPresence.meetingId, presenceUser.id, 'client', 0);
    await db
      .update(meetingPresence)
      .set({ deletedAt: new Date() })
      .where(eq(meetingPresence.id, opened.id));
    await expect(
      meetingPresenceRepository.listClientUserIdsForEngagement(softPresence.engagementId)
    ).resolves.toEqual([]);

    const softMeeting = await seedCaseMeeting();
    const meetingUser = await userFactory();
    await join(softMeeting.meetingId, meetingUser.id, 'client', 0);
    await db
      .update(meetings)
      .set({ deletedAt: new Date() })
      .where(eq(meetings.id, softMeeting.meetingId));
    await expect(
      meetingPresenceRepository.listClientUserIdsForEngagement(softMeeting.engagementId)
    ).resolves.toEqual([]);

    const softContext = await seedCaseMeeting();
    const contextUser = await userFactory();
    await join(softContext.meetingId, contextUser.id, 'client', 0);
    await db
      .update(meetingContexts)
      .set({ deletedAt: new Date() })
      .where(eq(meetingContexts.meetingId, softContext.meetingId));
    await expect(
      meetingPresenceRepository.listClientUserIdsForEngagement(softContext.engagementId)
    ).resolves.toEqual([]);
  });

  it('IGNORES a project_discovery context whose context_id is not an engagement id', async () => {
    // `context_id` is POLYMORPHIC: a discovery call points at a `project_requests.id`.
    // Matching on the id alone would read the wrong table's key space.
    const { engagementId } = await seedCaseMeeting();
    const discovery = await meetingFactory({
      contexts: [{ contextType: 'project_discovery', contextId: engagementId }],
    });
    const client = await userFactory();
    await join(discovery.meeting.id, client.id, 'client', 0);

    await expect(
      meetingPresenceRepository.listClientUserIdsForEngagement(engagementId)
    ).resolves.toEqual([]);
  });

  it('returns [] for an engagement with no meetings — the state BAL-390 actually ships in', async () => {
    // ⚠ THIS IS STILL PRODUCTION TODAY, for a narrower reason than it used to be. BAL-129
    // shipped a `meetings` writer (`POST /meetings`), but it ships INERT — no UI calls it
    // until BAL-400 — and PRESENCE rows are BAL-134's, which is unbuilt. Either way no
    // presence row exists, so the sweep falls back to the client company owner.
    const { engagement } = await engagementFactory();
    await expect(
      meetingPresenceRepository.listClientUserIdsForEngagement(engagement.id)
    ).resolves.toEqual([]);
  });

  it('spans MULTIPLE meetings held for the same engagement', async () => {
    const first = await seedCaseMeeting();
    const alex = await userFactory();
    const dana = await userFactory();
    await join(first.meetingId, alex.id, 'client', 0);

    const second = await meetingFactory({
      contexts: [{ contextType: 'project_kickoff', contextId: first.engagementId }],
    });
    await join(second.meeting.id, dana.id, 'client', 0);

    const ids = await meetingPresenceRepository.listClientUserIdsForEngagement(first.engagementId);
    expect(ids.sort()).toEqual([alex.id, dana.id].sort());
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

// ── BAL-412 — the SETTLEMENT read ────────────────────────────────────────────────────────

describe('meetingPresenceRepository.settlementFacts (BAL-412)', () => {
  it('returns BOTH reductions of ONE read — the clocks and the structural facts', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    const client = await userFactory();

    await join(meeting.id, expert.id, 'expert', 0);
    await join(meeting.id, client.id, 'client', 5);
    await leave(meeting.id, client.id, 35);
    await leave(meeting.id, expert.id, 40);

    const { clocks, facts } = await meetingPresenceRepository.settlementFacts(meeting.id, at(60));

    // The SAME numbers `clocks()` gives — `settlementFacts` is not a second, different clock.
    expect(clocks.expertPresentMs).toBe(40 * MIN);
    expect(clocks.billableMs).toBe(30 * MIN);
    expect(clocks.expertFirstJoinedAt?.getTime()).toBe(at(0).getTime());

    expect(facts.expertEverPresent).toBe(true);
    expect(facts.clientSideEverPresent).toBe(true);
    expect(facts.anyOpen).toBe(false);
    expect(facts.expertOpen).toBe(false);
    expect(facts.lastLeftAt?.getTime()).toBe(at(40).getTime());
  });

  it('⚠⚠ WHY THIS METHOD EXISTS: clientSideEverPresent is NOT derivable from the clocks', async () => {
    // A client who joined and left BEFORE the expert ever arrived. The two sides were NEVER in
    // the room together, so `billableStartedAt` is NULL and `billableMs` is 0 — which is
    // exactly what a genuine client no-show looks like on `MeetingClocks` alone. But a client
    // DID turn up, so this is not a `no_show_client`, and settling it as one would charge the
    // 15-minute floor for a call the client actually attended.
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    const client = await userFactory();

    await join(meeting.id, client.id, 'client', 0);
    await leave(meeting.id, client.id, 3);
    await join(meeting.id, expert.id, 'expert', 5);
    await leave(meeting.id, expert.id, 25);

    const { clocks, facts } = await meetingPresenceRepository.settlementFacts(meeting.id, at(60));

    // Indistinguishable from a no-show on the clocks…
    expect(clocks.billableMs).toBe(0);
    expect(clocks.billableStartedAt).toBeNull();
    // …and unambiguous on the facts. THIS is the field settlement branches on.
    expect(facts.clientSideEverPresent).toBe(true);
    expect(facts.expertEverPresent).toBe(true);
  });

  it('an OBSERVER is not client-side presence — a Balo staffer must not make a call billable', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    const staffer = await userFactory();

    await join(meeting.id, expert.id, 'expert', 0);
    await join(meeting.id, staffer.id, 'observer', 1);
    await leave(meeting.id, staffer.id, 20);
    await leave(meeting.id, expert.id, 20);

    const { clocks, facts } = await meetingPresenceRepository.settlementFacts(meeting.id, at(60));

    expect(facts.expertEverPresent).toBe(true);
    expect(facts.clientSideEverPresent).toBe(false); // the no-show input
    expect(clocks.expertPresentMs).toBe(20 * MIN);
    expect(clocks.billableMs).toBe(0);
  });

  it('the EXPERT-NEVER-JOINED shape: no expert interval ⇒ no clock and no first-join anchor', async () => {
    const { meeting } = await meetingFactory();
    const client = await userFactory();

    await join(meeting.id, client.id, 'client', 0);
    await leave(meeting.id, client.id, 20);

    const { clocks, facts } = await meetingPresenceRepository.settlementFacts(meeting.id, at(60));

    expect(facts.expertEverPresent).toBe(false);
    expect(facts.clientSideEverPresent).toBe(true);
    expect(clocks.expertFirstJoinedAt).toBeNull();
    expect(clocks.expertPresentMs).toBe(0);
  });

  it('an explicit `now` closes every still-OPEN interval at that instant, for the CLOCKS', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    const client = await userFactory();

    await join(meeting.id, expert.id, 'expert', 0);
    await join(meeting.id, client.id, 'client', 5);

    const { clocks, facts } = await meetingPresenceRepository.settlementFacts(meeting.id, at(25));

    expect(clocks.expertPresentMs).toBe(25 * MIN);
    expect(clocks.billableMs).toBe(20 * MIN);
    // `summarisePresence` reads NO ceiling — an open interval is reported as OPEN and
    // `lastLeftAt` stays null because nothing closed. That asymmetry is deliberate, and it is
    // why passing `now` to one reduction and not the other is correct.
    expect(facts.anyOpen).toBe(true);
    expect(facts.expertOpen).toBe(true);
    expect(facts.lastLeftAt).toBeNull();
  });

  it('with NO explicit `now`, a TERMINAL meeting measures to ended_at — never the wall clock', async () => {
    // Exactly how the settlement backstop calls it. `T0` is far in the past, so a regression
    // to `new Date()` would report weeks of expert-present time and settle a fortune.
    const { meeting } = await meetingFactory({
      values: { status: 'ended', outcome: 'completed', endedAt: at(30) },
    });
    const expert = await userFactory();
    const client = await userFactory();

    await join(meeting.id, expert.id, 'expert', 0);
    await join(meeting.id, client.id, 'client', 2);

    const { clocks, facts } = await meetingPresenceRepository.settlementFacts(meeting.id);

    expect(clocks.expertPresentMs).toBe(30 * MIN);
    expect(clocks.billableMs).toBe(28 * MIN);
    expect(clocks.expertPresentMs).toBeLessThan(24 * 60 * MIN);
    expect(facts.expertEverPresent).toBe(true);
    expect(facts.clientSideEverPresent).toBe(true);
  });

  it('a SOFT-DELETED interval is invisible to BOTH reductions', async () => {
    const { meeting } = await meetingFactory();
    const expert = await userFactory();
    const client = await userFactory();

    await join(meeting.id, expert.id, 'expert', 0);
    await leave(meeting.id, expert.id, 20);
    const clientInterval = await join(meeting.id, client.id, 'client', 5);
    await leave(meeting.id, client.id, 15);

    await db
      .update(meetingPresence)
      .set({ deletedAt: new Date() })
      .where(eq(meetingPresence.id, clientInterval.id));

    const { clocks, facts } = await meetingPresenceRepository.settlementFacts(meeting.id, at(60));

    // The client's attendance is gone from the FACTS as well as from the clocks — the two
    // reductions read the SAME rows, which is the whole point of the single read.
    expect(facts.clientSideEverPresent).toBe(false);
    expect(clocks.billableMs).toBe(0);
    expect(clocks.expertPresentMs).toBe(20 * MIN);
  });

  it('an EMPTY meeting yields the all-false facts and zero clocks (nobody ever joined)', async () => {
    const { meeting } = await meetingFactory();

    const { clocks, facts } = await meetingPresenceRepository.settlementFacts(meeting.id, at(60));

    expect(facts).toEqual({
      expertEverPresent: false,
      expertOpen: false,
      clientSideEverPresent: false,
      anyOpen: false,
      lastLeftAt: null,
      expertFirstJoinedAt: null,
    });
    expect(clocks.expertPresentMs).toBe(0);
    expect(clocks.billableMs).toBe(0);
  });
});
