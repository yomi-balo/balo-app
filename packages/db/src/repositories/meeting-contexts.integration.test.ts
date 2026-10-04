import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { CASE_INACTIVITY_DAYS, isCaseInactive } from '@balo/shared/engagements';
import { db } from '../client';
import {
  auditEvents,
  creditSessions,
  engagements,
  meetingContexts,
  meetings,
  type MeetingStatus,
  type NewMeeting,
} from '../schema';
import {
  actionItemFactory,
  caseEngagementFactory,
  conversationFileFactory,
  conversationMessageFactory,
  creditWalletFactory,
  expertDraftFactory,
  meetingAuditEventFactory,
  meetingFactory,
  meetingFileFactory,
  meetingRecordingFactory,
  projectRequestFactory,
  requestExpertRelationshipFactory,
  transcriptFactory,
  userFactory,
} from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { findProjectionForMeeting } from './_shared/consultation-projection';
import { MEETING_SCHEDULING_AUDIT_ACTIONS } from './_shared/meeting-audit';
import { actionItemsRepository } from './action-items';
import { conversationsRepository } from './conversations';
import { meetingsRepository } from './meetings';
import {
  meetingContextsRepository,
  MeetingAdminContextExistsError,
  MeetingPrimaryContextRepointedError,
  type ConsultationTimestamps,
} from './meeting-contexts';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Stands in for `apps/api`'s `MEETING_TOKEN_TTL_AFTER_END_MS`, which `@balo/db` cannot
 * import. `engagementIdsWithLiveCaseMeeting` takes the floor as a parameter, so these tests
 * only need the value to be self-consistent.
 */
const JOIN_WINDOW_AFTER_END_MS = DAY_MS;

/**
 * Every joinable shape the live-meeting exclusion must hold a case open for. Each one
 * contributes to NEITHER seam anchor: the first three because their start has passed, the
 * last because `in_progress` is never "upcoming" — and the server has no early-join bound,
 * so a future-start call can already be running.
 */
const JOINABLE_CALLS: ReadonlyArray<{
  label: string;
  status: MeetingStatus;
  startOffsetMs: number;
}> = [
  { label: '`scheduled` with its start passed', status: 'scheduled', startOffsetMs: -HOUR_MS },
  {
    label: '`waiting_for_participants` with its start passed',
    status: 'waiting_for_participants',
    startOffsetMs: -HOUR_MS,
  },
  { label: '`in_progress`', status: 'in_progress', startOffsetMs: -HOUR_MS },
  {
    label: '`in_progress` with a FUTURE start',
    status: 'in_progress',
    startOffsetMs: 2 * HOUR_MS,
  },
];

/** A two-hour meeting window starting `startOffsetMs` from `now`. */
function windowFrom(
  now: Date,
  startOffsetMs: number
): Pick<NewMeeting, 'scheduledStart' | 'scheduledEnd'> {
  const scheduledStart = new Date(now.getTime() + startOffsetMs);
  return { scheduledStart, scheduledEnd: new Date(scheduledStart.getTime() + 2 * HOUR_MS) };
}

/** Seeds one meeting carrying a single live `case` context on `engagementId`. */
async function seedCaseMeeting(engagementId: string, values: Partial<NewMeeting>): Promise<string> {
  const { meeting } = await meetingFactory({
    contexts: [{ contextType: 'case', contextId: engagementId }],
    values,
  });
  return meeting.id;
}

/**
 * Seeds a `credit_sessions` row directly against a meeting — the money side of the
 * BAL-425 read. `creditSessionsRepository.open` runs the whole money gate (wallet lock,
 * hold, rate resolution), which is orthogonal to what this suite asserts, so a raw insert
 * with a valid snapshot is both sufficient and far less brittle.
 */
async function seedCreditSession(input: {
  meetingId: string;
  endedAt: Date | null;
}): Promise<void> {
  const { wallet, companyId } = await creditWalletFactory();
  const expert = await expertDraftFactory();
  const member = await userFactory();

  await db.insert(creditSessions).values({
    walletId: wallet.id,
    companyId,
    expertProfileId: expert.id,
    initiatingMemberId: member.id,
    meetingId: input.meetingId,
    estimatedMinutes: 30,
    expertRateMinorPerHour: 30_000,
    clientRateMinorPerMinute: 625,
    expertRateMinorPerMinute: 500,
    effectiveCeilingMinor: 15_000,
    status: 'ended',
    endedAt: input.endedAt,
  });
}

describe('meetingContextsRepository.attach / listByMeeting', () => {
  it('MULTI-CONTEXT (D3) — one meeting carries a project_discovery row AND a project_kickoff row', async () => {
    const request = await projectRequestFactory();
    const { engagement } = await caseEngagementFactory();
    const { meeting } = await meetingFactory({ contexts: [] });

    await meetingContextsRepository.attach({
      meetingId: meeting.id,
      contextType: 'project_kickoff',
      contextId: engagement.id,
    });
    await meetingContextsRepository.attach({
      meetingId: meeting.id,
      contextType: 'project_discovery',
      contextId: request.id,
    });

    const rows = await meetingContextsRepository.listByMeeting(meeting.id);
    expect(rows).toHaveLength(2);
    // The unique is on the TRIPLE, never on meeting_id alone — one meeting legitimately
    // carries both grains. ⚠ ORDER MATTERS SINCE BAL-469, and the reverse order is now
    // REFUSED: attaching the tier-100 engagement context SECOND would repoint the primary
    // from the discovery request to the engagement (see the repoint test below). A meeting
    // that must carry both grains from the start is CREATED that way —
    // `meetingsRepository.create({ contexts: [discovery, kickoff] })`, pinned in
    // `_shared/consultation-projection.integration.test.ts`.
    expect(rows.map((r) => r.contextType).sort((a, b) => a.localeCompare(b))).toEqual([
      'project_discovery',
      'project_kickoff',
    ]);
  });

  it('REFUSES an attach that REPOINTS the primary — a tier-100 case over a tier-50 project_discovery (BAL-469)', async () => {
    const expert = await expertDraftFactory();
    const request = await projectRequestFactory({ expertProfileId: expert.id });
    // ⚠ Different companies by construction — both factories seed their own.
    const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });
    const created = await meetingsRepository.create({
      scheduledStart: new Date(Date.now() + HOUR_MS),
      scheduledEnd: new Date(Date.now() + 2 * HOUR_MS),
      contexts: [{ contextType: 'project_discovery', contextId: request.id }],
    });

    // The projected expert is UNCHANGED (`expert` both sides), so
    // `assertProjectionExpertUnchangedTx` cannot see this — that is the whole point.
    await expect(
      meetingContextsRepository.attach({
        meetingId: created.meeting.id,
        contextType: 'case',
        contextId: engagement.id,
      })
    ).rejects.toBeInstanceOf(MeetingPrimaryContextRepointedError);

    // …and the insert rolled back: still ONE context row, still the original discovery one.
    const rows = await meetingContextsRepository.listByMeeting(created.meeting.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contextType).toBe('project_discovery');
  });

  it('REFUSES the repoint on an UNBOOKED meeting too — the guard never reads `consultations` (BAL-469)', async () => {
    const expert = await expertDraftFactory();
    const request = await projectRequestFactory({ expertProfileId: expert.id });
    const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });
    // Raw insert (no `meetingsRepository.create`) ⇒ no projection row at all.
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'project_discovery', contextId: request.id }],
    });

    expect(await findProjectionForMeeting(meeting.id)).toBeUndefined();

    await expect(
      meetingContextsRepository.attach({
        meetingId: meeting.id,
        contextType: 'case',
        contextId: engagement.id,
      })
    ).rejects.toBeInstanceOf(MeetingPrimaryContextRepointedError);

    // ⚠ Proves the guard has no early-return hole: it refused the repoint on an UNBOOKED
    // meeting, which `assertProjectionExpertUnchangedTx` alone could never do (it early-
    // returns with no projection row).
    expect(await findProjectionForMeeting(meeting.id)).toBeUndefined();
    expect(await meetingContextsRepository.listByMeeting(meeting.id)).toHaveLength(1);
  });

  it('ALLOWS an attach that makes the primary AMBIGUOUS — it then names NO company, so nothing is silently flipped (BAL-469)', async () => {
    const expert = await expertDraftFactory();
    // Distinct engagements, distinct companies, SAME expert — so the expert guard stays
    // silent and only the new primary-stability guard is in play.
    const { engagement: first } = await caseEngagementFactory({ expertProfileId: expert.id });
    const { engagement: second } = await caseEngagementFactory({ expertProfileId: expert.id });
    const created = await meetingsRepository.create({
      scheduledStart: new Date(Date.now() + HOUR_MS),
      scheduledEnd: new Date(Date.now() + 2 * HOUR_MS),
      contexts: [{ contextType: 'case', contextId: first.id }],
    });

    await expect(
      meetingContextsRepository.attach({
        meetingId: created.meeting.id,
        contextType: 'case',
        contextId: second.id,
      })
    ).resolves.toBeDefined();

    expect(await meetingContextsRepository.listByMeeting(created.meeting.id)).toHaveLength(2);
  });

  it('ALLOWS an `admin` attach onto a meeting that already has a primary — admin rows never score (BAL-469)', async () => {
    const { engagement } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      scheduledStart: new Date(Date.now() + HOUR_MS),
      scheduledEnd: new Date(Date.now() + 2 * HOUR_MS),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    await expect(
      meetingContextsRepository.attach({
        meetingId: created.meeting.id,
        contextType: 'admin',
        contextId: null,
      })
    ).resolves.toBeDefined();

    expect(await meetingContextsRepository.listByMeeting(created.meeting.id)).toHaveLength(2);
  });

  it('a duplicate TRIPLE is idempotent — onConflictDoNothing returns the EXISTING row', async () => {
    const { engagement } = await caseEngagementFactory();
    const { meeting } = await meetingFactory({ contexts: [] });

    const first = await meetingContextsRepository.attach({
      meetingId: meeting.id,
      contextType: 'case',
      contextId: engagement.id,
    });
    const second = await meetingContextsRepository.attach({
      meetingId: meeting.id,
      contextType: 'case',
      contextId: engagement.id,
    });

    expect(second.id).toBe(first.id);
    expect(await meetingContextsRepository.listByMeeting(meeting.id)).toHaveLength(1);
  });

  it('TWO ADMIN ROWS on one meeting are rejected at the DB level (23505) — the NULL-uniqueness guard', async () => {
    const { meeting } = await meetingFactory({ contexts: [] });
    await meetingContextsRepository.attach({
      meetingId: meeting.id,
      contextType: 'admin',
      contextId: null,
    });

    // Postgres treats NULLs as DISTINCT, so `meeting_context_unique_idx` does NOT stop
    // this — `meeting_context_admin_uq` does. That index is not the onConflict arbiter, so
    // the violation surfaces rather than being silently swallowed.
    await expectConstraintViolation('23505', (tx) =>
      tx
        .insert(meetingContexts)
        .values({ meetingId: meeting.id, contextType: 'admin', contextId: null })
    );
  });

  it('a SECOND admin attach throws the NAMED MeetingAdminContextExistsError, not a raw 23505', async () => {
    const { meeting } = await meetingFactory({ contexts: [] });
    await meetingContextsRepository.attach({
      meetingId: meeting.id,
      contextType: 'admin',
      contextId: null,
    });

    // BAL-129/BAL-134 must be able to branch on a TYPE, never on a driver SQLSTATE string.
    await expect(
      meetingContextsRepository.attach({
        meetingId: meeting.id,
        contextType: 'admin',
        contextId: null,
      })
    ).rejects.toBeInstanceOf(MeetingAdminContextExistsError);

    // …and the failure is SAVEPOINT-contained: the ambient transaction is still usable, so
    // a caller that catches the named error can carry on rather than hitting 25P02.
    expect(await meetingContextsRepository.listByMeeting(meeting.id)).toHaveLength(1);
  });

  it('context_id NON-NULL with context_type=admin is rejected (23514)', async () => {
    const { meeting } = await meetingFactory({ contexts: [] });

    await expectConstraintViolation('23514', (tx) =>
      tx
        .insert(meetingContexts)
        .values({ meetingId: meeting.id, contextType: 'admin', contextId: randomUUID() })
    );
  });

  it('context_id NULL with ANY non-admin type is rejected (23514) — the biconditional', async () => {
    const { meeting } = await meetingFactory({ contexts: [] });

    await expectConstraintViolation('23514', (tx) =>
      tx
        .insert(meetingContexts)
        .values({ meetingId: meeting.id, contextType: 'case', contextId: null })
    );
    await expectConstraintViolation('23514', (tx) =>
      tx
        .insert(meetingContexts)
        .values({ meetingId: meeting.id, contextType: 'retainer_checkin', contextId: null })
    );
  });
});

describe('meetingContextsRepository.listMeetingsForContexts (BAL-540 — the batched reverse read)', () => {
  it('unifies the TWO request-grain id shapes in ONE query', async () => {
    // The whole reason the batched finder exists: `project_discovery` is keyed on the
    // REQUEST while `request_interaction` is keyed on the RELATIONSHIP
    // (`@balo/shared/meetings/context-owner.ts`), so a close cascade needs both shapes at
    // once — and N round trips inside a held request lock is N times the lock hold.
    const request = await projectRequestFactory();
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId ?? undefined,
    });

    const discovery = await meetingFactory({
      contexts: [{ contextType: 'project_discovery', contextId: request.id }],
      values: {
        scheduledStart: new Date(Date.now() + HOUR_MS),
        scheduledEnd: new Date(Date.now() + 2 * HOUR_MS),
      },
    });
    const interaction = await meetingFactory({
      contexts: [{ contextType: 'request_interaction', contextId: relationship.id }],
      values: {
        scheduledStart: new Date(Date.now() + 5 * HOUR_MS),
        scheduledEnd: new Date(Date.now() + 6 * HOUR_MS),
      },
    });
    // An unrelated meeting on another request must not leak in.
    const other = await projectRequestFactory();
    await meetingFactory({
      contexts: [{ contextType: 'project_discovery', contextId: other.id }],
    });

    const found = await meetingContextsRepository.listMeetingsForContexts([
      { contextType: 'project_discovery', contextId: request.id },
      { contextType: 'request_interaction', contextId: relationship.id },
    ]);

    // Ordered `scheduled_start, id`, matching the single-context read.
    expect(found.map((row) => row.meeting.id)).toEqual([
      discovery.meeting.id,
      interaction.meeting.id,
    ]);
    expect(found.map((row) => row.contextType)).toEqual([
      'project_discovery',
      'request_interaction',
    ]);
    expect(found.map((row) => row.contextId)).toEqual([request.id, relationship.id]);
  });

  it('EMPTY INPUT returns [] without issuing a query', async () => {
    // ⚠ Load-bearing, not defensive: an empty `or()` is a SQL SYNTAX ERROR in Drizzle, and a
    // request with no tracks is the common case for the close cascade.
    expect(await meetingContextsRepository.listMeetingsForContexts([])).toEqual([]);
  });

  it('excludes a soft-deleted CONTEXT row and a soft-deleted MEETING', async () => {
    const request = await projectRequestFactory();
    const detached = await meetingFactory({
      contexts: [{ contextType: 'project_discovery', contextId: request.id }],
    });
    const deletedMeeting = await meetingFactory({
      contexts: [{ contextType: 'project_discovery', contextId: request.id }],
      values: { deletedAt: new Date() },
    });
    const live = await meetingFactory({
      contexts: [{ contextType: 'project_discovery', contextId: request.id }],
    });

    await meetingContextsRepository.detach(detached.meeting.id, 'project_discovery', request.id);

    const found = await meetingContextsRepository.listMeetingsForContexts([
      { contextType: 'project_discovery', contextId: request.id },
    ]);
    const ids = found.map((row) => row.meeting.id);
    expect(ids).toEqual([live.meeting.id]);
    expect(ids).not.toContain(deletedMeeting.meeting.id);
  });

  it('groups many ids of the SAME type into one predicate', async () => {
    const request = await projectRequestFactory();
    const relationships = [];
    for (let i = 0; i < 3; i += 1) {
      const expert = await expertDraftFactory();
      const seeded = await requestExpertRelationshipFactory({
        projectRequestId: request.id,
        expertProfileId: expert.id,
      });
      relationships.push(seeded.relationship.id);
    }
    for (const relationshipId of relationships) {
      await meetingFactory({
        contexts: [{ contextType: 'request_interaction', contextId: relationshipId }],
      });
    }

    const found = await meetingContextsRepository.listMeetingsForContexts(
      relationships.map((contextId) => ({
        contextType: 'request_interaction' as const,
        contextId,
      }))
    );
    expect(found).toHaveLength(3);
    expect(found.map((row) => row.contextId).sort((a, b) => a.localeCompare(b))).toEqual(
      [...relationships].sort((a, b) => a.localeCompare(b))
    );
  });

  it('reads inside a caller-supplied transaction (the DbExecutor seam the cascade needs)', async () => {
    const request = await projectRequestFactory();
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'project_discovery', contextId: request.id }],
    });

    const found = await db.transaction((tx) =>
      meetingContextsRepository.listMeetingsForContexts(
        [{ contextType: 'project_discovery', contextId: request.id }],
        tx
      )
    );
    expect(found.map((row) => row.meeting.id)).toEqual([meeting.id]);
  });
});

describe('meetingContextsRepository.listMeetingsForContext / detach', () => {
  it('THE REVERSE READ — every live meeting for one context, earliest first', async () => {
    const { engagement } = await caseEngagementFactory();
    const later = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: {
        scheduledStart: new Date(Date.now() + 5 * HOUR_MS),
        scheduledEnd: new Date(Date.now() + 6 * HOUR_MS),
      },
    });
    const earlier = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: {
        scheduledStart: new Date(Date.now() + HOUR_MS),
        scheduledEnd: new Date(Date.now() + 2 * HOUR_MS),
      },
    });

    const found = await meetingContextsRepository.listMeetingsForContext('case', engagement.id);
    expect(found.map((m) => m.id)).toEqual([earlier.meeting.id, later.meeting.id]);
  });

  it('excludes a soft-deleted CONTEXT row and a soft-deleted MEETING', async () => {
    const { engagement } = await caseEngagementFactory();
    const detached = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    const deletedMeeting = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { deletedAt: new Date() },
    });
    const live = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    await meetingContextsRepository.detach(detached.meeting.id, 'case', engagement.id);

    const found = await meetingContextsRepository.listMeetingsForContext('case', engagement.id);
    expect(found.map((m) => m.id)).toEqual([live.meeting.id]);
    expect(found.map((m) => m.id)).not.toContain(deletedMeeting.meeting.id);
  });

  it('detach is a SOFT delete, so the same context re-attaches afterwards', async () => {
    const { engagement } = await caseEngagementFactory();
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    await meetingContextsRepository.detach(meeting.id, 'case', engagement.id);
    expect(await meetingContextsRepository.listByMeeting(meeting.id)).toHaveLength(0);

    const reattached = await meetingContextsRepository.attach({
      meetingId: meeting.id,
      contextType: 'case',
      contextId: engagement.id,
    });
    expect(reattached.deletedAt).toBeNull();

    const all = await db
      .select()
      .from(meetingContexts)
      .where(eq(meetingContexts.meetingId, meeting.id));
    expect(all).toHaveLength(2); // one stamped, one live
  });

  it('detach handles the NULL context_id (admin) branch', async () => {
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'admin', contextId: null }],
    });

    await meetingContextsRepository.detach(meeting.id, 'admin', null);

    expect(await meetingContextsRepository.listByMeeting(meeting.id)).toHaveLength(0);
  });
});

describe('meetingContextsRepository.consultationTimestampsForEngagements (THE BAL-425 SEAM)', () => {
  it('an empty id list returns an empty Map without touching the DB', async () => {
    expect(
      await meetingContextsRepository.consultationTimestampsForEngagements([], new Date())
    ).toEqual(new Map());
  });

  it('returns an entry for EVERY requested id, both null when nothing matches', async () => {
    const a = (await caseEngagementFactory()).engagement.id;
    const b = (await caseEngagementFactory()).engagement.id;
    const c = (await caseEngagementFactory()).engagement.id;

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [a, b, c],
      new Date()
    );

    expect(result.size).toBe(3);
    for (const id of [a, b, c]) {
      expect(result.get(id)).toEqual({
        lastCompletedConsultationAt: null,
        nextScheduledConsultationAt: null,
        lastSchedulingActivityAt: null,
      });
    }
  });

  it('completed WITH a credit session — the session ended_at wins over the meeting ended_at', async () => {
    const { engagement } = await caseEngagementFactory();
    const meetingEndedAt = new Date(Date.now() - 3 * DAY_MS);
    const sessionEndedAt = new Date(Date.now() - 2 * DAY_MS);

    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { status: 'ended', outcome: 'completed', endedAt: meetingEndedAt },
    });
    await seedCreditSession({ meetingId: meeting.id, endedAt: sessionEndedAt });

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagement.id],
      new Date()
    );

    expect(result.get(engagement.id)?.lastCompletedConsultationAt?.getTime()).toBe(
      sessionEndedAt.getTime()
    );
  });

  it('completed with NO credit session STILL counts (the LEFT JOIN case — comped/promo/parked-external)', async () => {
    const { engagement } = await caseEngagementFactory();
    const endedAt = new Date(Date.now() - 4 * DAY_MS);

    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { status: 'ended', outcome: 'completed', endedAt },
    });

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagement.id],
      new Date()
    );

    // Anchoring purely on credit_sessions.ended_at would make this case look
    // never-consulted and auto-close it. That is the bug the LEFT JOIN prevents.
    expect(result.get(engagement.id)?.lastCompletedConsultationAt?.getTime()).toBe(
      endedAt.getTime()
    );
  });

  it('an ended-but-NOT-completed meeting (no_show_client) is NOT a completed consultation', async () => {
    const { engagement } = await caseEngagementFactory();

    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: {
        status: 'ended',
        outcome: 'no_show_client',
        endedAt: new Date(Date.now() - DAY_MS),
      },
    });

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagement.id],
      new Date()
    );
    expect(result.get(engagement.id)?.lastCompletedConsultationAt).toBeNull();
  });

  it('takes the LATEST of several completed consultations', async () => {
    const { engagement } = await caseEngagementFactory();
    const older = new Date(Date.now() - 9 * DAY_MS);
    const newest = new Date(Date.now() - DAY_MS);

    for (const endedAt of [older, newest, new Date(Date.now() - 5 * DAY_MS)]) {
      await meetingFactory({
        contexts: [{ contextType: 'case', contextId: engagement.id }],
        values: { status: 'ended', outcome: 'completed', endedAt },
      });
    }

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagement.id],
      new Date()
    );
    expect(result.get(engagement.id)?.lastCompletedConsultationAt?.getTime()).toBe(
      newest.getTime()
    );
  });

  it('an UPCOMING scheduled meeting sets nextScheduledConsultationAt (earliest wins); a PAST one does not', async () => {
    const { engagement } = await caseEngagementFactory();
    const now = new Date();
    const soon = new Date(now.getTime() + DAY_MS);
    const later = new Date(now.getTime() + 5 * DAY_MS);
    const past = new Date(now.getTime() - DAY_MS);

    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { scheduledStart: later, scheduledEnd: new Date(later.getTime() + HOUR_MS) },
    });
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: {
        status: 'waiting_for_participants',
        scheduledStart: soon,
        scheduledEnd: new Date(soon.getTime() + HOUR_MS),
      },
    });
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { scheduledStart: past, scheduledEnd: new Date(past.getTime() + HOUR_MS) },
    });

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagement.id],
      now
    );
    expect(result.get(engagement.id)?.nextScheduledConsultationAt?.getTime()).toBe(soon.getTime());
  });

  it('an upcoming meeting in a TERMINAL status (ended) does not count as scheduled', async () => {
    const { engagement } = await caseEngagementFactory();
    const now = new Date();
    const future = new Date(now.getTime() + DAY_MS);

    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: {
        status: 'ended',
        scheduledStart: future,
        scheduledEnd: new Date(future.getTime() + HOUR_MS),
      },
    });

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagement.id],
      now
    );
    expect(result.get(engagement.id)?.nextScheduledConsultationAt).toBeNull();
  });

  it('a CANCELLED future meeting is NOT upcoming — the earliest LIVE scheduled one wins', async () => {
    const { engagement } = await caseEngagementFactory();
    const now = new Date();
    const cancelledStart = new Date(now.getTime() + DAY_MS);
    const liveStart = new Date(now.getTime() + 5 * DAY_MS);

    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: {
        status: 'cancelled',
        scheduledStart: cancelledStart,
        scheduledEnd: new Date(cancelledStart.getTime() + HOUR_MS),
      },
    });
    // A second, LIVE meeting as a positive control: a lone `toBeNull()` here would also
    // pass if the join or the context filter broke, not just if the status filter did its
    // job. This forces the query to have actually matched rows.
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: {
        scheduledStart: liveStart,
        scheduledEnd: new Date(liveStart.getTime() + HOUR_MS),
      },
    });

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagement.id],
      now
    );
    expect(result.get(engagement.id)?.nextScheduledConsultationAt?.getTime()).toBe(
      liveStart.getTime()
    );
    expect(result.get(engagement.id)?.lastCompletedConsultationAt).toBeNull();
  });

  it('a cancelled meeting can NEVER be a completed consultation — the DB refuses the state', async () => {
    const now = new Date();
    await expectConstraintViolation(
      '23514',
      (tx) =>
        tx.insert(meetings).values({
          status: 'cancelled',
          outcome: 'completed',
          scheduledStart: now,
          scheduledEnd: new Date(now.getTime() + HOUR_MS),
        }),
      'meeting_outcome_requires_ended'
    );
  });

  it('resolves BOTH timestamps for the same engagement', async () => {
    const { engagement } = await caseEngagementFactory();
    const now = new Date();
    const endedAt = new Date(now.getTime() - 2 * DAY_MS);
    const upcoming = new Date(now.getTime() + 3 * DAY_MS);

    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { status: 'ended', outcome: 'completed', endedAt },
    });
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { scheduledStart: upcoming, scheduledEnd: new Date(upcoming.getTime() + HOUR_MS) },
    });

    const timestamps = await meetingContextsRepository
      .consultationTimestampsForEngagements([engagement.id], now)
      .then((map) => map.get(engagement.id));

    expect(timestamps?.lastCompletedConsultationAt?.getTime()).toBe(endedAt.getTime());
    expect(timestamps?.nextScheduledConsultationAt?.getTime()).toBe(upcoming.getTime());
  });

  it('a SOFT-DELETED meeting is excluded from every anchor', async () => {
    const { engagement } = await caseEngagementFactory();
    const now = new Date();

    const completed = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: {
        status: 'ended',
        outcome: 'completed',
        endedAt: new Date(now.getTime() - DAY_MS),
        deletedAt: now,
      },
    });
    const upcoming = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: {
        scheduledStart: new Date(now.getTime() + DAY_MS),
        scheduledEnd: new Date(now.getTime() + DAY_MS + HOUR_MS),
        deletedAt: now,
      },
    });
    for (const { meeting } of [completed, upcoming]) {
      await meetingAuditEventFactory({
        meetingId: meeting.id,
        action: 'meeting.booked',
        createdAt: new Date(now.getTime() - 2 * DAY_MS),
      });
    }

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagement.id],
      now
    );
    expect(result.size).toBe(1);
    expect(result.get(engagement.id)).toEqual({
      lastCompletedConsultationAt: null,
      nextScheduledConsultationAt: null,
      lastSchedulingActivityAt: null,
    });
  });

  it('BATCHES — 3 ids in, 3 entries out, each resolved independently; an UNREQUESTED case and a context-less meeting never leak in', async () => {
    const now = new Date();
    const withCompleted = (await caseEngagementFactory()).engagement.id;
    const withUpcoming = (await caseEngagementFactory()).engagement.id;
    const withNeither = (await caseEngagementFactory()).engagement.id;
    const notRequested = (await caseEngagementFactory()).engagement.id;
    const endedAt = new Date(now.getTime() - DAY_MS);
    const upcoming = new Date(now.getTime() + DAY_MS);

    const completed = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: withCompleted }],
      values: { status: 'ended', outcome: 'completed', endedAt },
    });
    const scheduled = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: withUpcoming }],
      values: { scheduledStart: upcoming, scheduledEnd: new Date(upcoming.getTime() + HOUR_MS) },
    });
    const completedBooked = await meetingAuditEventFactory({
      meetingId: completed.meeting.id,
      action: 'meeting.booked',
      createdAt: new Date(now.getTime() - 10 * DAY_MS),
    });
    const upcomingBooked = await meetingAuditEventFactory({
      meetingId: scheduled.meeting.id,
      action: 'meeting.booked',
      createdAt: new Date(now.getTime() - DAY_MS),
    });

    // Newer scheduling rows the requested ids must never see: an unrequested case's meeting,
    // and a meeting with no context at all.
    const unrequested = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: notRequested }],
      values: { status: 'ended', outcome: 'no_show_client' },
    });
    await meetingAuditEventFactory({
      meetingId: unrequested.meeting.id,
      action: 'meeting.booked',
      createdAt: new Date(now.getTime() - 12 * HOUR_MS),
    });
    const contextless = await meetingFactory({ contexts: [] });
    await meetingAuditEventFactory({
      meetingId: contextless.meeting.id,
      action: 'meeting.booked',
      createdAt: new Date(now.getTime() - 6 * HOUR_MS),
    });

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [withCompleted, withUpcoming, withNeither],
      now
    );

    expect(result.size).toBe(3);
    expect(result.get(withCompleted)).toEqual({
      lastCompletedConsultationAt: endedAt,
      nextScheduledConsultationAt: null,
      lastSchedulingActivityAt: completedBooked.createdAt,
    });
    expect(result.get(withUpcoming)).toEqual({
      lastCompletedConsultationAt: null,
      nextScheduledConsultationAt: upcoming,
      lastSchedulingActivityAt: upcomingBooked.createdAt,
    });
    expect(result.get(withNeither)).toEqual({
      lastCompletedConsultationAt: null,
      nextScheduledConsultationAt: null,
      lastSchedulingActivityAt: null,
    });
  });

  it('a NON-case context (project_kickoff) on the same id does not leak into the case read', async () => {
    const { engagement } = await caseEngagementFactory();
    const now = new Date();

    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'project_kickoff', contextId: engagement.id }],
      values: {
        status: 'ended',
        outcome: 'completed',
        endedAt: new Date(now.getTime() - DAY_MS),
      },
    });
    await meetingAuditEventFactory({
      meetingId: meeting.id,
      action: 'meeting.booked',
      createdAt: new Date(now.getTime() - 2 * DAY_MS),
    });

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagement.id],
      now
    );
    expect(result.size).toBe(1);
    expect(result.get(engagement.id)).toEqual({
      lastCompletedConsultationAt: null,
      nextScheduledConsultationAt: null,
      lastSchedulingActivityAt: null,
    });
  });

  describe('lastSchedulingActivityAt — the latest booking, reschedule or cancellation (BAL-572)', () => {
    const ago = (ms: number): Date => new Date(Date.now() - ms);

    /** One case with one live case meeting, and the seam's entry for it. */
    async function seedCaseWithMeeting(
      values: Partial<NewMeeting> = {}
    ): Promise<{ engagementId: string; meetingId: string }> {
      const { engagement } = await caseEngagementFactory();
      const { meeting } = await meetingFactory({
        contexts: [{ contextType: 'case', contextId: engagement.id }],
        values,
      });
      return { engagementId: engagement.id, meetingId: meeting.id };
    }

    async function schedulingAnchor(engagementId: string): Promise<Date | null | undefined> {
      const result = await meetingContextsRepository.consultationTimestampsForEngagements(
        [engagementId],
        new Date()
      );
      expect(result.size).toBe(1);
      return result.get(engagementId)?.lastSchedulingActivityAt;
    }

    // Spelled out rather than read from `MEETING_SCHEDULING_AUDIT_ACTIONS`, so dropping an
    // action from the constant fails its case here instead of silently removing it.
    const SCHEDULING_ACTIONS = [
      'meeting.booked',
      'meeting.rescheduled',
      'meeting.cancelled',
    ] as const;

    it('the exported action set is exactly the three scheduling actions', () => {
      expect([...MEETING_SCHEDULING_AUDIT_ACTIONS].sort((a, b) => a.localeCompare(b))).toEqual(
        [...SCHEDULING_ACTIONS].sort((a, b) => a.localeCompare(b))
      );
    });

    it.each(SCHEDULING_ACTIONS)(
      'S1 — `%s` counts: newest of the three ⇒ its instant, as a real Date',
      async (action) => {
        const { engagementId, meetingId } = await seedCaseWithMeeting();
        for (const other of SCHEDULING_ACTIONS.filter((a) => a !== action)) {
          await meetingAuditEventFactory({ meetingId, action: other, createdAt: ago(10 * DAY_MS) });
        }
        const newest = await meetingAuditEventFactory({
          meetingId,
          action,
          createdAt: ago(DAY_MS),
        });

        const anchor = await schedulingAnchor(engagementId);

        expect(anchor).toBeInstanceOf(Date);
        expect(anchor?.getTime()).toBe(newest.createdAt.getTime());
      }
    );

    // One case per status, each putting the NEWEST row on a different meeting, so a filter that
    // drops any one status or outcome fails its own case (the older rows never decide it).
    const STATUS_BLIND_MEETINGS = [
      { label: 'a CANCELLED', values: { status: 'cancelled' }, action: 'meeting.cancelled' },
      {
        label: 'a MISSED (`ended` + `no_show_client`)',
        values: { status: 'ended', outcome: 'no_show_client' },
        action: 'meeting.booked',
      },
      { label: 'a future SCHEDULED', values: { status: 'scheduled' }, action: 'meeting.booked' },
    ] as const;

    it.each(STATUS_BLIND_MEETINGS)(
      'S2 — STATUS-BLIND: the newest row wins when it sits on $label meeting',
      async ({ label: newestLabel }) => {
        const { engagement } = await caseEngagementFactory();
        let newestRowAt: Date | undefined;
        for (const [index, seeded] of STATUS_BLIND_MEETINGS.entries()) {
          const isNewest = seeded.label === newestLabel;
          const { meeting } = await meetingFactory({
            contexts: [{ contextType: 'case', contextId: engagement.id }],
            values: seeded.values,
          });
          const row = await meetingAuditEventFactory({
            meetingId: meeting.id,
            action: seeded.action,
            createdAt: isNewest ? ago(DAY_MS) : ago((5 + index) * DAY_MS),
          });
          if (isNewest) newestRowAt = row.createdAt;
        }

        expect(newestRowAt).toBeInstanceOf(Date);
        expect((await schedulingAnchor(engagement.id))?.getTime()).toBe(newestRowAt?.getTime());
      }
    );

    it('S3 — `meeting.ended` / `meeting.outcome_resolved` and a non-meeting entity_type do NOT count', async () => {
      const { engagementId, meetingId } = await seedCaseWithMeeting({
        status: 'ended',
        outcome: 'no_show_client',
      });
      const booked = await meetingAuditEventFactory({
        meetingId,
        action: 'meeting.booked',
        createdAt: ago(10 * DAY_MS),
      });
      for (const action of ['meeting.ended', 'meeting.outcome_resolved'] as const) {
        await meetingAuditEventFactory({ meetingId, action, createdAt: ago(DAY_MS) });
      }
      // A scheduling action on the SAME entity_id under another entity_type.
      await db.insert(auditEvents).values({
        actorUserId: null,
        action: 'meeting.booked',
        entityType: 'consultation',
        entityId: meetingId,
        createdAt: ago(DAY_MS),
      });

      expect((await schedulingAnchor(engagementId))?.getTime()).toBe(booked.createdAt.getTime());
    });

    it('S4 — a soft-deleted CASE CONTEXT drops its meeting’s scheduling rows', async () => {
      const { engagementId, meetingId } = await seedCaseWithMeeting();
      await meetingAuditEventFactory({
        meetingId,
        action: 'meeting.booked',
        createdAt: ago(DAY_MS),
      });
      await meetingContextsRepository.detach(meetingId, 'case', engagementId);

      expect(await schedulingAnchor(engagementId)).toBeNull();
    });

    it('S5 — the REAL writers: a reschedule and then a cancellation each restart the anchor', async () => {
      const start = new Date(Date.now() + 3 * DAY_MS);
      const { engagementId, meetingId } = await seedCaseWithMeeting({
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + HOUR_MS),
      });
      const booked = await meetingAuditEventFactory({
        meetingId,
        action: 'meeting.booked',
        createdAt: ago(20 * DAY_MS),
      });
      expect((await schedulingAnchor(engagementId))?.getTime()).toBe(booked.createdAt.getTime());

      const movedStart = new Date(Date.now() + 5 * DAY_MS);
      const { rescheduleAuditId } = await meetingsRepository.updateSchedule(
        meetingId,
        { scheduledStart: movedStart, scheduledEnd: new Date(movedStart.getTime() + HOUR_MS) },
        { actorUserId: null }
      );
      const rescheduledAt = await auditCreatedAt(rescheduleAuditId);
      expect(rescheduledAt.getTime()).not.toBe(booked.createdAt.getTime());
      expect((await schedulingAnchor(engagementId))?.getTime()).toBe(rescheduledAt.getTime());

      const backdated = ago(15 * DAY_MS);
      await db
        .update(auditEvents)
        .set({ createdAt: backdated })
        .where(eq(auditEvents.id, rescheduleAuditId));
      expect((await schedulingAnchor(engagementId))?.getTime()).toBe(backdated.getTime());

      const { cancelAuditId } = await meetingsRepository.cancel(meetingId, {
        actorUserId: null,
        actorRole: 'system',
      });
      const cancelledAt = await auditCreatedAt(cancelAuditId);
      expect(cancelledAt.getTime()).toBeGreaterThan(backdated.getTime());
      expect((await schedulingAnchor(engagementId))?.getTime()).toBe(cancelledAt.getTime());
    });
  });
});

/** `created_at` of one audit row, read back by the id its writer returned. */
async function auditCreatedAt(auditId: string): Promise<Date> {
  const [row] = await db
    .select({ createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(eq(auditEvents.id, auditId));
  if (row === undefined) {
    throw new Error(`audit row ${auditId} not found`);
  }
  return row.createdAt;
}

describe('meetingContextsRepository.engagementIdsWithLiveCaseMeeting (the live-meeting exclusion)', () => {
  const floorFor = (now: Date): Date => new Date(now.getTime() - JOIN_WINDOW_AFTER_END_MS);

  it('an EMPTY id list returns an empty Set without querying', async () => {
    const select = vi.spyOn(db, 'select');
    const selectDistinct = vi.spyOn(db, 'selectDistinct');
    try {
      const held = await meetingContextsRepository.engagementIdsWithLiveCaseMeeting([], new Date());

      expect(held.size).toBe(0);
      expect(select).not.toHaveBeenCalled();
      expect(selectDistinct).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
      selectDistinct.mockRestore();
    }
  });

  it.each(JOINABLE_CALLS)(
    'HOLDS a case whose meeting is $label',
    async ({ status, startOffsetMs }) => {
      const now = new Date();
      const { engagement } = await caseEngagementFactory();
      await seedCaseMeeting(engagement.id, { status, ...windowFrom(now, startOffsetMs) });

      const held = await meetingContextsRepository.engagementIdsWithLiveCaseMeeting(
        [engagement.id],
        floorFor(now)
      );
      expect([...held]).toEqual([engagement.id]);
    }
  );

  // Each negative case below seeds a HELD control alongside it and asserts the exact result,
  // so an empty answer from a broken join or context filter cannot pass as an exclusion.

  it.each(['ended', 'cancelled'] as const)(
    'does NOT hold a case whose only meeting is `%s`, even with its end still ahead',
    async (status) => {
      const now = new Date();
      const { engagement: closed } = await caseEngagementFactory();
      const { engagement: control } = await caseEngagementFactory();
      await seedCaseMeeting(closed.id, { status, ...windowFrom(now, -HOUR_MS) });
      await seedCaseMeeting(control.id, { status: 'in_progress', ...windowFrom(now, -HOUR_MS) });

      const held = await meetingContextsRepository.engagementIdsWithLiveCaseMeeting(
        [closed.id, control.id],
        floorFor(now)
      );
      expect([...held]).toEqual([control.id]);
    }
  );

  it('does NOT count a SOFT-DELETED meeting', async () => {
    const now = new Date();
    const { engagement: deleted } = await caseEngagementFactory();
    const { engagement: control } = await caseEngagementFactory();
    // The factory leaves the context row LIVE, so only the meeting's own `deleted_at` can
    // exclude this one.
    await seedCaseMeeting(deleted.id, {
      status: 'in_progress',
      deletedAt: now,
      ...windowFrom(now, -HOUR_MS),
    });
    await seedCaseMeeting(control.id, { status: 'in_progress', ...windowFrom(now, -HOUR_MS) });

    const held = await meetingContextsRepository.engagementIdsWithLiveCaseMeeting(
      [deleted.id, control.id],
      floorFor(now)
    );
    expect([...held]).toEqual([control.id]);
  });

  it('does NOT count a meeting whose `case` context row is SOFT-DELETED', async () => {
    const now = new Date();
    const { engagement: detached } = await caseEngagementFactory();
    const { engagement: control } = await caseEngagementFactory();
    const meetingId = await seedCaseMeeting(detached.id, {
      status: 'in_progress',
      ...windowFrom(now, -HOUR_MS),
    });
    await seedCaseMeeting(control.id, { status: 'in_progress', ...windowFrom(now, -HOUR_MS) });
    await meetingContextsRepository.detach(meetingId, 'case', detached.id);

    const held = await meetingContextsRepository.engagementIdsWithLiveCaseMeeting(
      [detached.id, control.id],
      floorFor(now)
    );
    expect([...held]).toEqual([control.id]);
  });

  it('does NOT count a NON-case context (project_kickoff) on the same id', async () => {
    const now = new Date();
    const { engagement: kickoff } = await caseEngagementFactory();
    const { engagement: control } = await caseEngagementFactory();
    await meetingFactory({
      contexts: [{ contextType: 'project_kickoff', contextId: kickoff.id }],
      values: { status: 'in_progress', ...windowFrom(now, -HOUR_MS) },
    });
    await seedCaseMeeting(control.id, { status: 'in_progress', ...windowFrom(now, -HOUR_MS) });

    const held = await meetingContextsRepository.engagementIdsWithLiveCaseMeeting(
      [kickoff.id, control.id],
      floorFor(now)
    );
    expect([...held]).toEqual([control.id]);
  });

  it('the floor is STRICT — an end 1ms inside it holds, an end EXACTLY at it does not, nor one far past it', async () => {
    const now = new Date();
    const floor = floorFor(now);
    const endingAt = (end: Date): Partial<NewMeeting> => ({
      status: 'in_progress',
      scheduledStart: new Date(end.getTime() - HOUR_MS),
      scheduledEnd: end,
    });
    const { engagement: inside } = await caseEngagementFactory();
    const { engagement: atFloor } = await caseEngagementFactory();
    const { engagement: stranded } = await caseEngagementFactory();
    await seedCaseMeeting(inside.id, endingAt(new Date(floor.getTime() + 1)));
    await seedCaseMeeting(atFloor.id, endingAt(floor));
    await seedCaseMeeting(stranded.id, endingAt(new Date(floor.getTime() - 30 * DAY_MS)));

    const held = await meetingContextsRepository.engagementIdsWithLiveCaseMeeting(
      [inside.id, atFloor.id, stranded.id],
      floor
    );
    expect([...held]).toEqual([inside.id]);
  });

  it('BATCHES — one entry per held id however many meetings it has; unheld and unrequested ids are absent', async () => {
    const now = new Date();
    const { engagement: twoCalls } = await caseEngagementFactory();
    const { engagement: onlyEnded } = await caseEngagementFactory();
    const { engagement: noMeetings } = await caseEngagementFactory();
    const { engagement: notRequested } = await caseEngagementFactory();
    await seedCaseMeeting(twoCalls.id, { status: 'in_progress', ...windowFrom(now, -HOUR_MS) });
    await seedCaseMeeting(twoCalls.id, { status: 'scheduled', ...windowFrom(now, DAY_MS) });
    await seedCaseMeeting(onlyEnded.id, { status: 'ended', ...windowFrom(now, -HOUR_MS) });
    await seedCaseMeeting(notRequested.id, { status: 'in_progress', ...windowFrom(now, -HOUR_MS) });

    const held = await meetingContextsRepository.engagementIdsWithLiveCaseMeeting(
      [twoCalls.id, onlyEnded.id, noMeetings.id],
      floorFor(now)
    );
    expect([...held]).toEqual([twoCalls.id]);
  });
});

/**
 * CASE INACTIVITY COMPOSITION (BAL-417 × BAL-418) — the repository reads and the pure rule the
 * case-inactivity sweep (`apps/api/src/jobs/case-inactivity-sweep.ts`) stands on, composed
 * against a real database:
 *
 *     meetingContextsRepository.consultationTimestampsForEngagements(ids, now)
 *       (completed + scheduling anchors, next upcoming consultation)
 *     conversationsRepository.latestChatActivityAtForEngagements(ids)
 *       (messages, case-chat files, in-call uploads)
 *     actionItemsRepository.latestStatusChangeAtForEngagements(ids)
 *       (an action item marked done or reopened)
 *       ──feed──▶   isCaseInactive({ caseCreatedAt, ...anchors, now })
 *       ──minus──▶  meetingContextsRepository.engagementIdsWithLiveCaseMeeting(ids, floor)
 *
 * ⚠ THIS IS A COMPOSITION TEST, NOT A SWEEP. Auto-close is WINDOW MATH, not a consumer of
 * BAL-420's `schedule()` primitive — there is no per-instance promise to cancel, because a
 * candidate simply stops matching when the case gets activity. The sweep's orchestration is
 * unit-tested beside it.
 *
 * `caseEngagementsRepository.listOpenCreatedBefore` returns only the SQL-expressible,
 * creation-anchored, activity-BLIND superset; the two reads and the rule refine it, and they
 * can only refine what they are handed. The live-meeting exclusion is the last filter (cases
 * 8 and 9): the consultation anchors ignore a call that is running now or whose start has
 * passed, so on the anchors alone a case could close mid-call.
 *
 * ⚠ `NOW` IS FIXED, SO EVERY ROW THE RULE READS CARRIES AN EXPLICIT TIMESTAMP RELATIVE TO IT:
 * each seeded audit, message, file and upload row sets `createdAt`, and a row written by a
 * real mutator (`cancel`, `updateSchedule`) is stamped with the wall clock — after `NOW` — so
 * it is backdated by its returned audit id before any assertion. Every meeting added for
 * BAL-572 also sets its status and window relative to `NOW`: `meetingFactory`'s default
 * window is `Date.now() + 1h`, which reads as UPCOMING against `NOW` and would make an ACTIVE
 * expectation vacuous.
 */
describe('case inactivity composition (BAL-417 × BAL-418)', () => {
  /** Every input the three reads supply for one case, taken ONLY from their Maps. */
  async function anchorsFor(
    engagementId: string,
    now: Date
  ): Promise<
    ConsultationTimestamps & {
      lastChatActivityAt: Date | null;
      lastActionItemActivityAt: Date | null;
    }
  > {
    const anchors = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagementId],
      now
    );
    const chat = await conversationsRepository.latestChatActivityAtForEngagements([engagementId]);
    const timestamps = anchors.get(engagementId);
    if (timestamps === undefined) {
      throw new Error(`consultationTimestampsForEngagements dropped ${engagementId}`);
    }
    const lastChatActivityAt = chat.get(engagementId);
    if (lastChatActivityAt === undefined) {
      throw new Error(`latestChatActivityAtForEngagements dropped ${engagementId}`);
    }
    const toggles = await actionItemsRepository.latestStatusChangeAtForEngagements([engagementId]);
    const lastActionItemActivityAt = toggles.get(engagementId);
    if (lastActionItemActivityAt === undefined) {
      throw new Error(`latestStatusChangeAtForEngagements dropped ${engagementId}`);
    }
    return { ...timestamps, lastChatActivityAt, lastActionItemActivityAt };
  }

  /** Resolve every anchor for one case and apply the rule, exactly as the sweep does. */
  async function inactive(engagementId: string, caseCreatedAt: Date, now: Date): Promise<boolean> {
    return isCaseInactive({ now, caseCreatedAt, ...(await anchorsFor(engagementId, now)) });
  }

  const NOW = new Date('2026-08-05T12:00:00.000Z');
  const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);
  const daysAhead = (days: number): Date => new Date(NOW.getTime() + days * DAY_MS);
  const FLOOR = new Date(NOW.getTime() - JOIN_WINDOW_AFTER_END_MS);

  /** A case created `days` before `NOW`, with its thread and a user to write into it. */
  async function caseCreatedDaysAgo(days: number): Promise<{
    engagementId: string;
    createdAt: Date;
    conversationId: string;
    userId: string;
  }> {
    const { engagement, conversationId } = await caseEngagementFactory({
      values: { createdAt: daysAgo(days) },
    });
    const user = await userFactory();
    return {
      engagementId: engagement.id,
      createdAt: engagement.createdAt,
      conversationId,
      userId: user.id,
    };
  }

  /** A case meeting that ENDED `endedDaysAgo` before `NOW`, in a one-hour window ending then. */
  async function endedCaseMeeting(
    engagementId: string,
    endedDaysAgo: number,
    outcome: 'completed' | 'no_show_client'
  ): Promise<string> {
    const endedAt = daysAgo(endedDaysAgo);
    return seedCaseMeeting(engagementId, {
      status: 'ended',
      outcome,
      endedAt,
      scheduledStart: new Date(endedAt.getTime() - HOUR_MS),
      scheduledEnd: endedAt,
    });
  }

  /** Backdate one audit row, found by the id its real writer returned. */
  async function backdateAudit(auditId: string, createdAt: Date): Promise<void> {
    await db.update(auditEvents).set({ createdAt }).where(eq(auditEvents.id, auditId));
  }

  /** The sweep's last filter: does a still-joinable case meeting hold this case open? */
  async function heldOpen(engagementId: string): Promise<boolean> {
    const held = await meetingContextsRepository.engagementIdsWithLiveCaseMeeting(
      [engagementId],
      FLOOR
    );
    return held.has(engagementId);
  }

  it('1 — created 31d ago with NO meeting contexts at all ⇒ INACTIVE', async () => {
    const { engagement } = await caseEngagementFactory({ values: { createdAt: daysAgo(31) } });

    // The seam still returns an entry (all three fields null) and the chat read a null, so the
    // rule falls back to the creation anchor — "absent" never has to be distinguished from
    // "none".
    expect(await inactive(engagement.id, engagement.createdAt, NOW)).toBe(true);
  });

  it('2 — last COMPLETED consultation 31d ago, none scheduled ⇒ INACTIVE', async () => {
    const { engagement } = await caseEngagementFactory({ values: { createdAt: daysAgo(60) } });
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { status: 'ended', outcome: 'completed', endedAt: daysAgo(31) },
    });

    expect(await inactive(engagement.id, engagement.createdAt, NOW)).toBe(true);
  });

  it('3 — last completed 31d ago but one SCHEDULED TOMORROW ⇒ ACTIVE (a future commitment always wins)', async () => {
    const { engagement } = await caseEngagementFactory({ values: { createdAt: daysAgo(60) } });
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { status: 'ended', outcome: 'completed', endedAt: daysAgo(31) },
    });
    const upcoming = daysAhead(1);
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { scheduledStart: upcoming, scheduledEnd: new Date(upcoming.getTime() + HOUR_MS) },
    });

    expect(await inactive(engagement.id, engagement.createdAt, NOW)).toBe(false);
  });

  it('3b — ⚠ PASSING HAND-BUILT NULL ANCHORS FLIPS CASE 3 TO INACTIVE. That is the whole point of this test.', async () => {
    const { engagement } = await caseEngagementFactory({ values: { createdAt: daysAgo(60) } });
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { status: 'ended', outcome: 'completed', endedAt: daysAgo(31) },
    });
    const upcoming = daysAhead(1);
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { scheduledStart: upcoming, scheduledEnd: new Date(upcoming.getTime() + HOUR_MS) },
    });

    // Skipping the BAL-418 read collapses the rule to "created ≥ 30 days ago" and would
    // AUTO-CLOSE a case with a consultation yesterday and another booked tomorrow. It is
    // now a BUG, not a gap — pinned here so a future sweep cannot quietly reintroduce it.
    expect(
      isCaseInactive({
        now: NOW,
        caseCreatedAt: engagement.createdAt,
        lastCompletedConsultationAt: null,
        nextScheduledConsultationAt: null,
        lastSchedulingActivityAt: null,
        lastChatActivityAt: null,
        lastActionItemActivityAt: null,
      })
    ).toBe(true);
    // …while the composed answer, on the same row, is the correct one.
    expect(await inactive(engagement.id, engagement.createdAt, NOW)).toBe(false);
  });

  it('4 — created 90d ago but last completed YESTERDAY ⇒ ACTIVE (the anchor moves off creation)', async () => {
    const { engagement } = await caseEngagementFactory({ values: { createdAt: daysAgo(90) } });
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { status: 'ended', outcome: 'completed', endedAt: daysAgo(1) },
    });

    expect(await inactive(engagement.id, engagement.createdAt, NOW)).toBe(false);
  });

  it('5 — only a PAST scheduled consultation ⇒ INACTIVE (a past schedule never blocks)', async () => {
    const { engagement } = await caseEngagementFactory({ values: { createdAt: daysAgo(45) } });
    const past = daysAgo(40);
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { scheduledStart: past, scheduledEnd: new Date(past.getTime() + HOUR_MS) },
    });

    // It contributes to NEITHER anchor: not upcoming, and never `ended`+`completed`.
    expect(await inactive(engagement.id, engagement.createdAt, NOW)).toBe(true);
  });

  it('6 — anchor EXACTLY 30d ago ⇒ INACTIVE (the boundary is inclusive)', async () => {
    const { engagement } = await caseEngagementFactory({ values: { createdAt: daysAgo(90) } });
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: {
        status: 'ended',
        outcome: 'completed',
        endedAt: daysAgo(CASE_INACTIVITY_DAYS),
      },
    });

    expect(await inactive(engagement.id, engagement.createdAt, NOW)).toBe(true);
  });

  it('7 — the ONLY consultation was CANCELLED ⇒ the cancellation restarts the 30 days (BAL-572)', async () => {
    const { engagement } = await caseEngagementFactory({ values: { createdAt: daysAgo(31) } });
    const upcoming = daysAhead(1);
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: { scheduledStart: upcoming, scheduledEnd: new Date(upcoming.getTime() + HOUR_MS) },
    });

    // Pre-assert: while the call is booked, the case is held open. This proves the
    // engagement, the context row and the seam are all wired correctly, so every later flip
    // can only come from the cancellation below, not from a wiring accident.
    expect(await inactive(engagement.id, engagement.createdAt, NOW)).toBe(false);

    // Cancel through the REAL production path, not by seeding a cancelled row — this is
    // what turns "a cancelled row is excluded from upcoming" into "production cancellation
    // leaves a row the seam then excludes", and it writes the real `meeting.cancelled` row.
    const { cancelAuditId } = await meetingsRepository.cancel(meeting.id, {
      actorUserId: null,
      actorRole: 'system',
    });

    // A day-old cancellation holds the case: the cancellation is the only anchor newer than
    // creation, and the cancelled meeting no longer counts as upcoming.
    await backdateAudit(cancelAuditId, daysAgo(1));
    expect(await inactive(engagement.id, engagement.createdAt, NOW)).toBe(false);

    const anchors = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagement.id],
      NOW
    );
    expect(anchors.get(engagement.id)).toEqual({
      lastCompletedConsultationAt: null,
      nextScheduledConsultationAt: null,
      lastSchedulingActivityAt: daysAgo(1),
    });

    // A 31-day-old cancellation does NOT: the cancelled meeting is excluded from "upcoming",
    // so nothing else holds it.
    await backdateAudit(cancelAuditId, daysAgo(31));
    expect(await inactive(engagement.id, engagement.createdAt, NOW)).toBe(true);

    // The exclusion must be attributable to the STATUS FILTER ALONE. If cancel ever starts
    // soft-deleting the meeting or its context rows, the booleans above keep passing for a
    // DIFFERENT reason, and the corrected docblock's "excluded ONLY by the status filter"
    // becomes false. Fail here instead, so that change is made deliberately.
    const [cancelledMeeting] = await db
      .select({ status: meetings.status, deletedAt: meetings.deletedAt })
      .from(meetings)
      .where(eq(meetings.id, meeting.id));
    expect(cancelledMeeting?.status).toBe('cancelled');
    expect(cancelledMeeting?.deletedAt).toBeNull();

    const [contextRow] = await db
      .select({ deletedAt: meetingContexts.deletedAt })
      .from(meetingContexts)
      .where(eq(meetingContexts.meetingId, meeting.id));
    expect(contextRow?.deletedAt).toBeNull();
  });

  it.each(JOINABLE_CALLS)(
    '8 — created 31d ago, its only call $label ⇒ the anchors say INACTIVE, the exclusion HOLDS it',
    async ({ status, startOffsetMs }) => {
      const { engagement } = await caseEngagementFactory({ values: { createdAt: daysAgo(31) } });
      await seedCaseMeeting(engagement.id, { status, ...windowFrom(NOW, startOffsetMs) });

      // Both halves on the same row: the seam alone would close this case mid-call, and the
      // exclusion is what keeps it open.
      expect(await inactive(engagement.id, engagement.createdAt, NOW)).toBe(true);
      expect(await heldOpen(engagement.id)).toBe(true);
    }
  );

  it('9 — a STRANDED `in_progress` call that ended far past the floor ⇒ INACTIVE and NOT held, so the case stays eligible', async () => {
    const { engagement } = await caseEngagementFactory({ values: { createdAt: daysAgo(45) } });
    const end = daysAgo(40);
    await seedCaseMeeting(engagement.id, {
      status: 'in_progress',
      scheduledStart: new Date(end.getTime() - HOUR_MS),
      scheduledEnd: end,
    });

    expect(await inactive(engagement.id, engagement.createdAt, NOW)).toBe(true);
    expect(await heldOpen(engagement.id)).toBe(false);
  });

  // ── Chat activity: messages (BAL-572) ─────────────────────────────────────

  /** One live message in the case's thread, `days` before `NOW`. */
  async function messageDaysAgo(
    kase: { conversationId: string; userId: string },
    days: number,
    deletedAt?: Date
  ): Promise<void> {
    await conversationMessageFactory({
      conversationId: kase.conversationId,
      senderUserId: kase.userId,
      createdAt: daysAgo(days),
      ...(deletedAt === undefined ? {} : { deletedAt }),
    });
  }

  it('10 — created 45d ago, never consulted, a message 5d ago ⇒ ACTIVE', async () => {
    const kase = await caseCreatedDaysAgo(45);
    await messageDaysAgo(kase, 5);

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(false);
  });

  it('11 — last completed 40d ago and last message 31d ago ⇒ INACTIVE', async () => {
    const kase = await caseCreatedDaysAgo(60);
    await endedCaseMeeting(kase.engagementId, 40, 'completed');
    await messageDaysAgo(kase, 31);

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(true);
  });

  it('12 — last completed 5d ago and last message 40d ago ⇒ ACTIVE (the newer anchor wins)', async () => {
    const kase = await caseCreatedDaysAgo(60);
    await endedCaseMeeting(kase.engagementId, 5, 'completed');
    await messageDaysAgo(kase, 40);

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(false);
  });

  /** Mark an action item on the case done `days` before `NOW` (the audit row is the anchor). */
  async function itemTickedDaysAgo(
    kase: { engagementId: string; userId: string },
    days: number
  ): Promise<void> {
    const { actionItem } = await actionItemFactory({ engagementId: kase.engagementId });
    await db.insert(auditEvents).values({
      actorUserId: kase.userId,
      action: 'action_item.completed',
      entityType: 'action_item',
      entityId: actionItem.id,
      metadata: { engagementId: kase.engagementId },
      createdAt: daysAgo(days),
    });
  }

  it('12a — last completed 40d ago, an action item ticked 5d ago ⇒ ACTIVE', async () => {
    const kase = await caseCreatedDaysAgo(60);
    await endedCaseMeeting(kase.engagementId, 40, 'completed');
    await itemTickedDaysAgo(kase, 5);

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(false);
    // The tick alone holds it: null it out and the same case reads inactive.
    const anchors = await anchorsFor(kase.engagementId, NOW);
    expect(
      isCaseInactive({
        now: NOW,
        caseCreatedAt: kase.createdAt,
        ...anchors,
        lastActionItemActivityAt: null,
      })
    ).toBe(true);
  });

  it('12b — an action item ticked 31d ago, nothing newer ⇒ INACTIVE', async () => {
    const kase = await caseCreatedDaysAgo(60);
    await itemTickedDaysAgo(kase, 31);

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(true);
  });

  it('13 — last message EXACTLY 30d ago ⇒ INACTIVE (the boundary is inclusive)', async () => {
    const kase = await caseCreatedDaysAgo(45);
    await messageDaysAgo(kase, CASE_INACTIVITY_DAYS);

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(true);
  });

  it('14 — only a SOFT-DELETED message, 1d ago ⇒ INACTIVE', async () => {
    const kase = await caseCreatedDaysAgo(45);
    await messageDaysAgo(kase, 1, daysAgo(1));

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(true);
  });

  it('15 — ⚠ a NULL chat anchor flips case 10 to INACTIVE; the composed answer stays ACTIVE', async () => {
    const kase = await caseCreatedDaysAgo(45);
    await messageDaysAgo(kase, 5);
    const anchors = await anchorsFor(kase.engagementId, NOW);

    // Hand-building the chat input instead of taking it from the read's Map collapses the rule
    // to "created ≥ 30 days ago" for a case whose parties spoke five days ago.
    expect(
      isCaseInactive({
        now: NOW,
        caseCreatedAt: kase.createdAt,
        ...anchors,
        lastChatActivityAt: null,
      })
    ).toBe(true);
    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(false);
  });

  // ── Chat activity: files and in-call uploads (BAL-572) ────────────────────

  it('16 — created 45d ago, a case-chat FILE 5d ago and no message ⇒ ACTIVE', async () => {
    const kase = await caseCreatedDaysAgo(45);
    await conversationFileFactory({
      conversationId: kase.conversationId,
      uploadedByUserId: kase.userId,
      createdAt: daysAgo(5),
    });

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(false);
  });

  it('16b — created 45d ago, a missed call with an in-call UPLOAD 5d ago and no message ⇒ ACTIVE', async () => {
    const kase = await caseCreatedDaysAgo(45);
    const meetingId = await endedCaseMeeting(kase.engagementId, 5, 'no_show_client');
    await meetingFileFactory({ meetingId, source: 'chat', createdAt: daysAgo(5) });

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(false);
  });

  it('16c — the same call with a RECORDING and a TRANSCRIPT 5d ago but no upload ⇒ INACTIVE', async () => {
    const kase = await caseCreatedDaysAgo(45);
    const meetingId = await endedCaseMeeting(kase.engagementId, 5, 'no_show_client');
    await meetingRecordingFactory({ meetingId, status: 'ready', createdAt: daysAgo(5) });
    await transcriptFactory({
      engagementId: kase.engagementId,
      meetingId,
      values: { createdAt: daysAgo(5) },
    });

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(true);
  });

  // ── Scheduling activity: bookings, reschedules, cancellations (BAL-572) ───

  it('17 — booked 20d ago, then MISSED ⇒ ACTIVE (the booking holds the case)', async () => {
    const kase = await caseCreatedDaysAgo(60);
    const meetingId = await endedCaseMeeting(kase.engagementId, 10, 'no_show_client');
    await meetingAuditEventFactory({ meetingId, action: 'meeting.booked', createdAt: daysAgo(20) });

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(false);
  });

  it('18 — booked 31d ago, then missed 17d ago ⇒ INACTIVE (a miss restarts nothing)', async () => {
    const kase = await caseCreatedDaysAgo(60);
    const meetingId = await endedCaseMeeting(kase.engagementId, 17, 'no_show_client');
    await meetingAuditEventFactory({ meetingId, action: 'meeting.booked', createdAt: daysAgo(31) });
    for (const action of ['meeting.ended', 'meeting.outcome_resolved'] as const) {
      await meetingAuditEventFactory({ meetingId, action, createdAt: daysAgo(17) });
    }

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(true);
  });

  /** Case 19's shape: booked 40d ago, rescheduled 3d ago, then missed yesterday. */
  async function bookedMovedThenMissed(): Promise<{ engagementId: string; createdAt: Date }> {
    const kase = await caseCreatedDaysAgo(60);
    const meetingId = await endedCaseMeeting(kase.engagementId, 1, 'no_show_client');
    await meetingAuditEventFactory({ meetingId, action: 'meeting.booked', createdAt: daysAgo(40) });
    await meetingAuditEventFactory({
      meetingId,
      action: 'meeting.rescheduled',
      createdAt: daysAgo(3),
    });
    return kase;
  }

  it('19 — booked 40d ago, RESCHEDULED 3d ago, then missed ⇒ ACTIVE (a reschedule restarts)', async () => {
    const kase = await bookedMovedThenMissed();

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(false);
  });

  it('20 — newest scheduling row EXACTLY 30d ago ⇒ INACTIVE (the boundary is inclusive)', async () => {
    const kase = await caseCreatedDaysAgo(60);
    const meetingId = await endedCaseMeeting(kase.engagementId, 25, 'no_show_client');
    await meetingAuditEventFactory({
      meetingId,
      action: 'meeting.booked',
      createdAt: daysAgo(CASE_INACTIVITY_DAYS),
    });

    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(true);
  });

  it('21 — ⚠ a NULL scheduling anchor flips case 19 to INACTIVE; the composed answer stays ACTIVE', async () => {
    const kase = await bookedMovedThenMissed();
    const anchors = await anchorsFor(kase.engagementId, NOW);

    expect(
      isCaseInactive({
        now: NOW,
        caseCreatedAt: kase.createdAt,
        ...anchors,
        lastSchedulingActivityAt: null,
      })
    ).toBe(true);
    expect(await inactive(kase.engagementId, kase.createdAt, NOW)).toBe(false);
  });

  it('THE CLOCK IS SHARED — `caseCreatedAt` is the PARENT engagements.created_at', async () => {
    const created = daysAgo(31);
    const { engagement } = await caseEngagementFactory({ values: { createdAt: created } });

    // `listOpenCreatedBefore` filters on the SAME column, so the candidate set and this
    // refinement cannot diverge on two clocks. Read it back from the supertype row rather
    // than trusting the projection.
    const [parent] = await db
      .select({ createdAt: engagements.createdAt })
      .from(engagements)
      .where(eq(engagements.id, engagement.id));
    expect(parent?.createdAt.getTime()).toBe(created.getTime());
    expect(engagement.createdAt.getTime()).toBe(created.getTime());
  });
});
