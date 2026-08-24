import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lt, ne } from 'drizzle-orm';
import { db } from '../../client';
import { consultations, meetingContexts, meetings } from '../../schema';
import type { Consultation, MeetingContextType } from '../../schema';
import {
  caseEngagementFactory,
  expertDraftFactory,
  meetingFactory,
  projectRequestFactory,
} from '../../test/factories';
import { consultationsRepository } from '../consultations';
import { meetingContextsRepository } from '../meeting-contexts';
import { meetingsRepository, MeetingNotReschedulableError } from '../meetings';
import {
  MatchModeDiscoveryNotBookableError,
  MeetingContextUnresolvableError,
  MeetingExpertAmbiguousError,
  consultationStatusForMeeting,
  findProjectionDrift,
  findProjectionForMeeting,
  scanAllProjectionDrift,
} from './consultation-projection';

/**
 * BAL-428 — `consultations` as a READ MODEL of `meetings`.
 *
 * This suite owns the projection writer itself: expert resolution through the
 * `meeting_contexts` seam, the four lifecycle writers, the `attach` guard, and the
 * reconciliation read. It carries its OWN fixtures rather than leaning on
 * `meetings.integration.test.ts`'s, so a change to that suite's fixtures can never quietly
 * make these assertions vacuous.
 */

const HOUR_MS = 3_600_000;

function schedule(offsetHours = 1): { scheduledStart: Date; scheduledEnd: Date } {
  const start = Date.now() + offsetHours * HOUR_MS;
  return { scheduledStart: new Date(start), scheduledEnd: new Date(start + HOUR_MS) };
}

/** EVERY projection row for a meeting, soft-deleted ones included. */
async function allProjectionRows(meetingId: string): Promise<Consultation[]> {
  return db.select().from(consultations).where(eq(consultations.meetingId, meetingId));
}

/** Seed one engagement and one project request that name the SAME expert. */
async function seedOneExpertGraph(): Promise<{
  expertProfileId: string;
  engagementId: string;
  projectRequestId: string;
}> {
  const expert = await expertDraftFactory();
  const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });
  const request = await projectRequestFactory({ expertProfileId: expert.id });
  return {
    expertProfileId: expert.id,
    engagementId: engagement.id,
    projectRequestId: request.id,
  };
}

// ── Expert resolution ───────────────────────────────────────────────────

describe('consultation projection — expert resolution through the context seam', () => {
  it('a case context resolves to the ENGAGEMENT’s expert and writes a confirmed projection', async () => {
    const expert = await expertDraftFactory();
    const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });
    const window = schedule();

    const created = await meetingsRepository.create({
      ...window,
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    expect(created.expertProfileId).toBe(expert.id);

    const projection = await findProjectionForMeeting(created.meeting.id);
    expect(projection?.expertProfileId).toBe(expert.id);
    expect(projection?.status).toBe('confirmed');
    // The projection MIRRORS the meeting's window — it does not compute its own.
    expect(projection?.startAt.getTime()).toBe(window.scheduledStart.getTime());
    expect(projection?.endAt.getTime()).toBe(window.scheduledEnd.getTime());
    expect(projection?.meetingId).toBe(created.meeting.id);
  });

  it.each<MeetingContextType>(['project_kickoff', 'package_session', 'retainer_checkin'])(
    'a %s context also resolves through engagements.expert_profile_id',
    async (contextType) => {
      const expert = await expertDraftFactory();
      const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });

      const created = await meetingsRepository.create({
        ...schedule(),
        contexts: [{ contextType, contextId: engagement.id }],
      });

      expect(created.expertProfileId).toBe(expert.id);
      expect((await findProjectionForMeeting(created.meeting.id))?.expertProfileId).toBe(expert.id);
    }
  );

  it('a project_discovery context resolves through PROJECT_REQUESTS, not engagements', async () => {
    // A discovery call happens BEFORE any engagement exists — the whole reason that context
    // type reads a different table.
    const expert = await expertDraftFactory();
    const request = await projectRequestFactory({ expertProfileId: expert.id });

    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'project_discovery', contextId: request.id }],
    });

    expect(created.expertProfileId).toBe(expert.id);
    expect((await findProjectionForMeeting(created.meeting.id))?.expertProfileId).toBe(expert.id);
  });

  it('AC #5 — an ADMIN-ONLY meeting projects NOTHING and blocks nobody', async () => {
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'admin', contextId: null }],
    });

    // The meeting exists…
    expect(await meetingsRepository.findById(created.meeting.id)).toBeDefined();
    // …and not one consultation row was written, soft-deleted or otherwise.
    expect(created.expertProfileId).toBeNull();
    expect(await findProjectionForMeeting(created.meeting.id)).toBeUndefined();
    expect(await allProjectionRows(created.meeting.id)).toHaveLength(0);
  });

  it('an admin context alongside a real one is IGNORED, not treated as a second expert', async () => {
    const expert = await expertDraftFactory();
    const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });

    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [
        { contextType: 'case', contextId: engagement.id },
        { contextType: 'admin', contextId: null },
      ],
    });

    expect(created.expertProfileId).toBe(expert.id);
  });

  it('TWO contexts naming the SAME expert resolve cleanly (one expert, not two)', async () => {
    const { expertProfileId, engagementId, projectRequestId } = await seedOneExpertGraph();

    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [
        { contextType: 'project_discovery', contextId: projectRequestId },
        { contextType: 'project_kickoff', contextId: engagementId },
      ],
    });

    expect(created.expertProfileId).toBe(expertProfileId);
    expect(await allProjectionRows(created.meeting.id)).toHaveLength(1);
  });
});

// ── Resolution failures — each must roll the WHOLE meeting back ─────────

describe('consultation projection — a booking that cannot name one expert is refused', () => {
  it('TWO DIFFERENT experts throw MeetingExpertAmbiguousError and write NO meeting at all', async () => {
    const { engagement: first } = await caseEngagementFactory();
    const { engagement: second } = await caseEngagementFactory();
    const before = await db.select({ id: meetings.id }).from(meetings);

    await expect(
      meetingsRepository.create({
        ...schedule(),
        contexts: [
          { contextType: 'case', contextId: first.id },
          { contextType: 'project_kickoff', contextId: second.id },
        ],
      })
    ).rejects.toBeInstanceOf(MeetingExpertAmbiguousError);

    // The projection write is INSIDE the meeting's transaction, so the meeting and its
    // context rows roll back with it. A half-written booking is the failure mode this
    // ticket exists to make impossible.
    const after = await db.select({ id: meetings.id }).from(meetings);
    expect(after).toHaveLength(before.length);
  });

  it('a MATCH-MODE project request throws MatchModeDiscoveryNotBookableError', async () => {
    // send_to='match' ⟺ expert_profile_id IS NULL (the project_request_send_to_expert
    // CHECK), i.e. nobody has been routed the request yet — there is no calendar to book.
    const request = await projectRequestFactory({ sendTo: 'match', expertProfileId: null });
    const before = await db.select({ id: meetings.id }).from(meetings);

    await expect(
      meetingsRepository.create({
        ...schedule(),
        contexts: [{ contextType: 'project_discovery', contextId: request.id }],
      })
    ).rejects.toBeInstanceOf(MatchModeDiscoveryNotBookableError);

    expect(await db.select({ id: meetings.id }).from(meetings)).toHaveLength(before.length);
  });

  it('an UNRESOLVABLE context id throws rather than silently booking nobody', async () => {
    // `context_id` has NO FK (it is polymorphic), so a wrong uuid raises no 23503. Treating
    // it as "no expert" would produce a live meeting blocking nobody's calendar — exactly
    // the double-booking this ticket closes.
    await expect(
      meetingsRepository.create({
        ...schedule(),
        contexts: [{ contextType: 'case', contextId: randomUUID() }],
      })
    ).rejects.toBeInstanceOf(MeetingContextUnresolvableError);
  });

  it('a SOFT-DELETED engagement is unresolvable too (the resolver reads live rows only)', async () => {
    const { engagement } = await caseEngagementFactory({ values: { deletedAt: new Date() } });

    await expect(
      meetingsRepository.create({
        ...schedule(),
        contexts: [{ contextType: 'case', contextId: engagement.id }],
      })
    ).rejects.toBeInstanceOf(MeetingContextUnresolvableError);
  });
});

// ── Lifecycle writers ───────────────────────────────────────────────────

describe('consultation projection — lifecycle', () => {
  it('updateSchedule MOVES the projected window inside the same transaction', async () => {
    const expert = await expertDraftFactory();
    const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    const next = schedule(48);

    const result = await meetingsRepository.updateSchedule(created.meeting.id, next, {
      actorUserId: null,
    });

    expect(result.expertProfileId).toBe(expert.id);
    const projection = await findProjectionForMeeting(created.meeting.id);
    expect(projection?.startAt.getTime()).toBe(next.scheduledStart.getTime());
    expect(projection?.endAt.getTime()).toBe(next.scheduledEnd.getTime());
    // Still ONE row — a reschedule moves the booking, it does not add a second.
    expect(await allProjectionRows(created.meeting.id)).toHaveLength(1);
  });

  it('updateSchedule now REFUSES waiting_for_participants (BAL-409 settled the asymmetry)', async () => {
    // ⚠ THIS INVERTS the pre-BAL-409 guard. `waiting_for_participants` used to be reschedulable
    // alongside `scheduled`; BAL-409 (orchestrator D-B) narrowed the guard to `scheduled` ALONE
    // — the join window already opened, and moving it would leave a STALE status (D12). See
    // `meetingsRepository.updateSchedule`'s docblock for the full reasoning.
    const expert = await expertDraftFactory();
    const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    await db
      .update(meetings)
      .set({ status: 'waiting_for_participants' })
      .where(eq(meetings.id, created.meeting.id));
    const next = schedule(72);

    await expect(
      meetingsRepository.updateSchedule(created.meeting.id, next, { actorUserId: null })
    ).rejects.toBeInstanceOf(MeetingNotReschedulableError);
    expect((await findProjectionForMeeting(created.meeting.id))?.startAt.getTime()).not.toBe(
      next.scheduledStart.getTime()
    );
  });

  it('THE CANCEL-THEN-RESCHEDULE REGRESSION — a cancelled meeting CANNOT be rescheduled', async () => {
    // ⚠ THE DOUBLE-BOOKING THIS TICKET EXISTS TO CLOSE, IN THE ONE SHAPE THE RECONCILIATION
    // READ IS BLIND TO. Without `updateSchedule`'s status guard:
    //   cancel(M)                     → meeting `cancelled`, projection `cancelled`.
    //   updateSchedule(M, 14:00)      → `syncProjectionScheduleTx` moves start/end but
    //                                   NEVER recomputes status, so the projection stays
    //                                   `cancelled` while the meeting is live at 14:00.
    //   listConfirmedInRange          → filters `status='confirmed'`, skips it ⇒ A LIVE
    //                                   MEETING THAT BLOCKS NOBODY.
    //   findProjectionDrift           → reports NOTHING; the two rows AGREE.
    //
    // ⚠ NOTE FOR ANYONE WEAKENING THE GUARD AND EXPECTING THIS TEST TO CATCH IT: the
    // `listConfirmedInRange` assertions below would STILL PASS, because the whole defect is
    // that the moved projection stays `cancelled` and is therefore invisible to that read.
    // The assertions that actually detect it are the `rejects` above, the "nothing moved"
    // block (1), and — the one that names the real harm — the LIVE-MEETING OVERLAP COUNT in
    // (3). Do not delete (3) as redundant; it is the only one that sees the double booking.
    const expert = await expertDraftFactory();
    const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });
    const original = schedule();
    const created = await meetingsRepository.create({
      ...original,
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    await meetingsRepository.cancel(created.meeting.id);

    const target = schedule(48);
    const targetRange = [
      new Date(target.scheduledStart.getTime() - HOUR_MS),
      new Date(target.scheduledEnd.getTime() + HOUR_MS),
    ] as const;

    await expect(
      meetingsRepository.updateSchedule(created.meeting.id, target, { actorUserId: null })
    ).rejects.toBeInstanceOf(MeetingNotReschedulableError);

    // 1. NOTHING MOVED. The meeting is still cancelled, still on its original window, and
    //    its projection was not dragged into the future behind the rejected call.
    const reloaded = await meetingsRepository.findById(created.meeting.id);
    expect(reloaded?.status).toBe('cancelled');
    expect(reloaded?.scheduledStart.getTime()).toBe(original.scheduledStart.getTime());
    const projection = await findProjectionForMeeting(created.meeting.id);
    expect(projection?.status).toBe('cancelled');
    expect(projection?.startAt.getTime()).toBe(original.scheduledStart.getTime());

    // 2. THE LOAD-BEARING ONE — the target window is still BOOKABLE. Nothing occupies it…
    expect(await consultationsRepository.listConfirmedInRange(expert.id, ...targetRange)).toEqual(
      []
    );

    // …and it can genuinely be booked, by a DIFFERENT meeting, with exactly one row blocking
    // it afterwards. A window that merely "returns no rows" could be one a broken filter is
    // hiding; a window a second booking lands cleanly in is one that was actually free.
    const second = await meetingsRepository.create({
      ...target,
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    const blocking = await consultationsRepository.listConfirmedInRange(expert.id, ...targetRange);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.meetingId).toBe(second.meeting.id);

    // 3. THE DOUBLE-BOOKING ASSERTION ITSELF — counted on `meetings`, NOT on the projection.
    //    This is the one that fails if the guard is weakened. A reschedule that slipped
    //    through would leave the cancelled meeting LIVE and `scheduled` on the target window
    //    alongside the second booking: two real calls, same expert, same hour, one of them
    //    invisible to every availability read. Counting live meetings rather than confirmed
    //    projections is the whole point — the projection is exactly what the bug hides in.
    //    Scoped to the two meetings this test created, so it asserts a fact about them
    //    rather than about whatever else happens to be in the transaction.
    const overlapping = await db
      .select({ id: meetings.id })
      .from(meetings)
      .where(
        and(
          inArray(meetings.id, [created.meeting.id, second.meeting.id]),
          isNull(meetings.deletedAt),
          ne(meetings.status, 'cancelled'),
          lt(meetings.scheduledStart, target.scheduledEnd),
          gt(meetings.scheduledEnd, target.scheduledStart)
        )
      );
    expect(overlapping.map((row) => row.id)).toEqual([second.meeting.id]);

    // 4. And the drift read stays silent throughout — which is precisely WHY the guard has
    //    to live in `updateSchedule`. Reconciliation cannot be the safety net here.
    expect(
      await findProjectionDrift({ meetingIds: [created.meeting.id, second.meeting.id] })
    ).toEqual([]);
  });

  it.each([
    { label: 'ended', status: 'ended' as const },
    { label: 'in_progress', status: 'in_progress' as const },
  ])(
    'a $label meeting cannot be rescheduled, and its projected window does not move',
    async ({ status }) => {
      // `ended` and `in_progress` are excluded for the cancel reason PLUS an independent
      // one: a delivered or running call must not be silently moved into the future.
      const expert = await expertDraftFactory();
      const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });
      const original = schedule();
      const created = await meetingsRepository.create({
        ...original,
        contexts: [{ contextType: 'case', contextId: engagement.id }],
      });
      // Driven through a raw UPDATE because the repository exposes no status mutator —
      // BAL-134 owns the transition map (the `meetingFactory` `values` precedent).
      await db.update(meetings).set({ status }).where(eq(meetings.id, created.meeting.id));

      await expect(
        meetingsRepository.updateSchedule(created.meeting.id, schedule(48), { actorUserId: null })
      ).rejects.toBeInstanceOf(MeetingNotReschedulableError);

      expect((await findProjectionForMeeting(created.meeting.id))?.startAt.getTime()).toBe(
        original.scheduledStart.getTime()
      );
    }
  );

  it('a SOFT-DELETED meeting is not reschedulable either', async () => {
    const { engagement } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    await meetingsRepository.softDelete(created.meeting.id);

    await expect(
      meetingsRepository.updateSchedule(created.meeting.id, schedule(48), { actorUserId: null })
    ).rejects.toBeInstanceOf(MeetingNotReschedulableError);
  });

  it('cancel FREES the slot for the availability resolver', async () => {
    const expert = await expertDraftFactory();
    const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });
    const window = schedule();
    const created = await meetingsRepository.create({
      ...window,
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    // Booked: the resolver sees it.
    const rangeStart = new Date(window.scheduledStart.getTime() - HOUR_MS);
    const rangeEnd = new Date(window.scheduledEnd.getTime() + HOUR_MS);
    expect(
      await consultationsRepository.listConfirmedInRange(expert.id, rangeStart, rangeEnd)
    ).toHaveLength(1);

    const result = await meetingsRepository.cancel(created.meeting.id);

    expect(result.meeting.status).toBe('cancelled');
    expect(result.expertProfileId).toBe(expert.id);
    // The ROW SURVIVES (auditable, and `consultations_meeting_uq` still holds) — it is the
    // status filter, not a delete, that hands the window back.
    const projection = await findProjectionForMeeting(created.meeting.id);
    expect(projection?.status).toBe('cancelled');
    expect(projection?.deletedAt).toBeNull();
    expect(
      await consultationsRepository.listConfirmedInRange(expert.id, rangeStart, rangeEnd)
    ).toEqual([]);
  });

  it('cancel is guarded — a second cancel, and a non-scheduled meeting, both throw', async () => {
    const { engagement } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    await meetingsRepository.cancel(created.meeting.id);

    // Cancelling twice must not "succeed" again and re-fire whatever the caller does
    // post-commit (an availability rebuild today; a notification tomorrow).
    await expect(meetingsRepository.cancel(created.meeting.id)).rejects.toThrow(/not cancellable/);

    const { meeting: inProgress } = await meetingFactory({ values: { status: 'in_progress' } });
    await expect(meetingsRepository.cancel(inProgress.id)).rejects.toThrow(/not cancellable/);
    await expect(meetingsRepository.cancel(randomUUID())).rejects.toThrow(/not cancellable/);
  });

  it('softDelete STAMPS the projection and reports whose availability changed', async () => {
    const expert = await expertDraftFactory();
    const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    const result = await meetingsRepository.softDelete(created.meeting.id);

    expect(result.expertProfileId).toBe(expert.id);
    expect(await findProjectionForMeeting(created.meeting.id)).toBeUndefined();
    const [stamped] = await allProjectionRows(created.meeting.id);
    expect(stamped?.deletedAt).not.toBeNull();
  });

  it('softDelete THROWS on a meeting that is already gone (no more silent no-op)', async () => {
    const { meeting } = await meetingFactory({ contexts: [] });
    await meetingsRepository.softDelete(meeting.id);

    // Returning a MeetingMutationResult means there is no honest value to hand back when
    // nothing was deleted — and a caller told "done" would rebuild nobody's availability.
    await expect(meetingsRepository.softDelete(meeting.id)).rejects.toThrow(/Meeting not found/);
  });

  it('the partial unique lets a soft-deleted projection be re-created for the SAME meeting id', async () => {
    // `consultations_meeting_uq` is PARTIAL on deleted_at IS NULL. A non-partial unique
    // would make the stamped row block this insert forever — memory
    // `reference_softdelete_nonpartial_unique_recreate`.
    const expert = await expertDraftFactory();
    const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    await meetingsRepository.softDelete(created.meeting.id);

    await db.insert(consultations).values({
      meetingId: created.meeting.id,
      expertProfileId: expert.id,
      startAt: created.meeting.scheduledStart,
      endAt: created.meeting.scheduledEnd,
    });

    expect(await allProjectionRows(created.meeting.id)).toHaveLength(2);
  });

  it('consultationStatusForMeeting maps ONLY the cancelled label to a freed slot', () => {
    expect(consultationStatusForMeeting('cancelled')).toBe('cancelled');
    // `ended` stays confirmed: a delivered consultation is a fact the hero stat counts, and
    // its window is in the past so it can never block a future slot.
    for (const status of [
      'scheduled',
      'waiting_for_participants',
      'in_progress',
      'ended',
    ] as const) {
      expect(consultationStatusForMeeting(status)).toBe('confirmed');
    }
  });
});

// ── The `attach` guard — the second door ────────────────────────────────

describe('consultation projection — the attach guard', () => {
  // `attach`'s SIBLING guard — `assertPrimaryContextUnchangedTx` (BAL-469), which refuses a
  // REPOINT of the meeting's primary context — is pinned in `meeting-contexts.integration.test.ts`
  // and `_shared/meeting-context-owner.integration.test.ts`, not here. Every test below was
  // walked against it — cited by TITLE, not by line, because line numbers drift on the next
  // edit (they already have once): `'attaching a context naming a DIFFERENT expert is REFUSED
  // and rolls the attach back'` is ambiguous-after (allowed), `'attaching a context naming the
  // SAME expert is allowed'` is a lower-tier attach (unchanged winner), `'attach NEVER creates
  // a projection row — it is not a booking path'` establishes a primary on an admin-only
  // meeting (none → ok).
  it('attaching a context naming a DIFFERENT expert is REFUSED and rolls the attach back', async () => {
    const { engagement: booked } = await caseEngagementFactory();
    const { engagement: other } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: booked.id }],
    });

    await expect(
      meetingContextsRepository.attach({
        meetingId: created.meeting.id,
        contextType: 'project_kickoff',
        contextId: other.id,
      })
    ).rejects.toBeInstanceOf(MeetingExpertAmbiguousError);

    // The context row did NOT survive, and the projection still blocks the original expert.
    expect(await meetingContextsRepository.listByMeeting(created.meeting.id)).toHaveLength(1);
    expect((await findProjectionForMeeting(created.meeting.id))?.expertProfileId).toBe(
      created.expertProfileId
    );
  });

  it('attaching a context naming the SAME expert is allowed', async () => {
    const { expertProfileId, engagementId, projectRequestId } = await seedOneExpertGraph();
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagementId }],
    });

    await meetingContextsRepository.attach({
      meetingId: created.meeting.id,
      contextType: 'project_discovery',
      contextId: projectRequestId,
    });

    expect(await meetingContextsRepository.listByMeeting(created.meeting.id)).toHaveLength(2);
    expect((await findProjectionForMeeting(created.meeting.id))?.expertProfileId).toBe(
      expertProfileId
    );
  });

  it('an IDEMPOTENT re-attach never trips the guard (the conflict branch is not re-resolved)', async () => {
    const { engagement } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    const again = await meetingContextsRepository.attach({
      meetingId: created.meeting.id,
      contextType: 'case',
      contextId: engagement.id,
    });

    expect(again.meetingId).toBe(created.meeting.id);
    expect(await meetingContextsRepository.listByMeeting(created.meeting.id)).toHaveLength(1);
  });

  it('attach NEVER creates a projection row — it is not a booking path', async () => {
    // An admin meeting that later gains a real context does NOT become a booking. Only
    // `meetingsRepository.create` books; the resulting inconsistency is DRIFT, reported by
    // `findProjectionDrift`, not something attach may invent a booking to hide.
    const { engagement } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'admin', contextId: null }],
    });

    await meetingContextsRepository.attach({
      meetingId: created.meeting.id,
      contextType: 'case',
      contextId: engagement.id,
    });

    expect(await findProjectionForMeeting(created.meeting.id)).toBeUndefined();
    const drift = await findProjectionDrift({ meetingIds: [created.meeting.id] });
    expect(drift.map((row) => row.kind)).toEqual(['missing_projection']);
  });

  it('detach is a DELIBERATE no-op on the projection — a re-tag must not un-book a slot', async () => {
    const expert = await expertDraftFactory();
    const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    await meetingContextsRepository.detach(created.meeting.id, 'case', engagement.id);

    // The slot is STILL blocked. Freeing it here would hand an expert's reserved time back
    // to the marketplace while the meeting still exists — see detach()'s docblock.
    const projection = await findProjectionForMeeting(created.meeting.id);
    expect(projection?.status).toBe('confirmed');
    expect(projection?.expertProfileId).toBe(expert.id);
    // …and the now-inconsistent state is REPORTED rather than hidden.
    const drift = await findProjectionDrift({ meetingIds: [created.meeting.id] });
    expect(drift.map((row) => row.kind)).toEqual(['expert_mismatch']);
  });
});

// ── THE RECONCILIATION READ ─────────────────────────────────────────────

describe('findProjectionDrift — did availability and meetings ever disagree?', () => {
  it('THE MAIN ASSERTION — a booking written through the writer reports ZERO drift', async () => {
    const { engagementId, projectRequestId } = await seedOneExpertGraph();
    const booked = await meetingsRepository.create({
      ...schedule(),
      contexts: [
        { contextType: 'case', contextId: engagementId },
        { contextType: 'project_discovery', contextId: projectRequestId },
      ],
    });
    const rescheduled = await meetingsRepository.create({
      ...schedule(3),
      contexts: [{ contextType: 'case', contextId: engagementId }],
    });
    await meetingsRepository.updateSchedule(rescheduled.meeting.id, schedule(9), {
      actorUserId: null,
    });
    const cancelled = await meetingsRepository.create({
      ...schedule(5),
      contexts: [{ contextType: 'case', contextId: engagementId }],
    });
    await meetingsRepository.cancel(cancelled.meeting.id);
    const deleted = await meetingsRepository.create({
      ...schedule(7),
      contexts: [{ contextType: 'case', contextId: engagementId }],
    });
    await meetingsRepository.softDelete(deleted.meeting.id);
    const admin = await meetingsRepository.create({
      ...schedule(11),
      contexts: [{ contextType: 'admin', contextId: null }],
    });

    // Every lifecycle path, including the admin meeting that correctly projects nothing.
    const drift = await findProjectionDrift({
      meetingIds: [
        booked.meeting.id,
        rescheduled.meeting.id,
        cancelled.meeting.id,
        deleted.meeting.id,
        admin.meeting.id,
      ],
    });
    expect(drift).toEqual([]);
  });

  it('reports missing_projection for a meeting that was never projected', async () => {
    // `meetingFactory` inserts RAW, bypassing the writer — the shape a pre-BAL-428 row, or
    // a hand-written INSERT, would leave behind.
    const { engagement } = await caseEngagementFactory();
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    const drift = await findProjectionDrift({ meetingIds: [meeting.id] });

    expect(drift).toHaveLength(1);
    expect(drift[0]?.kind).toBe('missing_projection');
    expect(drift[0]?.meetingId).toBe(meeting.id);
    expect(drift[0]?.consultationId).toBeNull();
  });

  it('reports window_mismatch when the projection is moved behind the writer’s back', async () => {
    const { engagement } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    // ⚠ MOVE BOTH BOUNDS, NOT JUST `start_at`. `consultations_start_before_end_check`
    // enforces `start_at < end_at` ON THE ROW, so shifting only the start past the
    // untouched end raises 23514 and the test dies before asserting anything (it did
    // exactly that on first CI run). The drift modelled here is "the projection disagrees
    // with its MEETING" — a different thing from "the row is internally corrupt" — so the
    // row has to stay valid on its own terms for this fixture to isolate it.
    const movedStart = new Date(created.meeting.scheduledStart.getTime() + 100 * HOUR_MS);
    await db
      .update(consultations)
      .set({ startAt: movedStart, endAt: new Date(movedStart.getTime() + HOUR_MS) })
      .where(eq(consultations.meetingId, created.meeting.id));

    const drift = await findProjectionDrift({ meetingIds: [created.meeting.id] });
    expect(drift.map((row) => row.kind)).toEqual(['window_mismatch']);
    expect(drift[0]?.detail).toContain('vs projection');
  });

  it('reports status_mismatch when a live meeting’s slot was freed without cancelling it', async () => {
    const { engagement } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    await db
      .update(consultations)
      .set({ status: 'cancelled' })
      .where(eq(consultations.meetingId, created.meeting.id));

    const drift = await findProjectionDrift({ meetingIds: [created.meeting.id] });
    expect(drift.map((row) => row.kind)).toEqual(['status_mismatch']);
  });

  it('reports orphaned_projection when the meeting is soft-deleted but the slot stays blocked', async () => {
    const { engagement } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    // Stamp ONLY the meeting — the shape `softDelete` would leave if it stopped stamping
    // the projection. This is the regression that assertion exists to catch.
    const now = new Date();
    await db.update(meetings).set({ deletedAt: now }).where(eq(meetings.id, created.meeting.id));
    await db
      .update(meetingContexts)
      .set({ deletedAt: now })
      .where(
        and(
          eq(meetingContexts.meetingId, created.meeting.id),
          eq(meetingContexts.contextType, 'case')
        )
      );

    const drift = await findProjectionDrift({ meetingIds: [created.meeting.id] });
    expect(drift.map((row) => row.kind)).toEqual(['orphaned_projection']);
    expect(drift[0]?.consultationId).not.toBeNull();
  });

  it('an empty meetingIds list short-circuits to no drift', async () => {
    expect(await findProjectionDrift({ meetingIds: [] })).toEqual([]);
  });

  it('scans EVERY live meeting when unscoped (the default the reconciliation job will use)', async () => {
    const { engagement } = await caseEngagementFactory();
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    // The UNSCOPED scan is its own named function — `findProjectionDrift` now REQUIRES
    // `meetingIds`, so a full-table read cannot be produced by forgetting an argument.
    // This must still find the unprojected meeting: a scan that silently covered nothing
    // would make the reconciliation job a permanent green light.
    const drift = await scanAllProjectionDrift();
    expect(
      drift.some((row) => row.meetingId === meeting.id && row.kind === 'missing_projection')
    ).toBe(true);
  });
});
