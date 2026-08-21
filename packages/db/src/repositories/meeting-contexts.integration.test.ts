import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { CASE_INACTIVITY_DAYS, isCaseInactive } from '@balo/shared/engagements';
import { db } from '../client';
import { creditSessions, engagements, meetingContexts } from '../schema';
import {
  caseEngagementFactory,
  creditWalletFactory,
  expertDraftFactory,
  meetingFactory,
  projectRequestFactory,
  userFactory,
} from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { findProjectionForMeeting } from './_shared/consultation-projection';
import { meetingsRepository } from './meetings';
import {
  meetingContextsRepository,
  MeetingAdminContextExistsError,
  MeetingPrimaryContextRepointedError,
} from './meeting-contexts';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

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
    expect(rows.map((r) => r.contextType).sort()).toEqual(['project_discovery', 'project_kickoff']);
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

  it('a SOFT-DELETED meeting is excluded from both anchors', async () => {
    const { engagement } = await caseEngagementFactory();
    const now = new Date();

    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: {
        status: 'ended',
        outcome: 'completed',
        endedAt: new Date(now.getTime() - DAY_MS),
        deletedAt: now,
      },
    });
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      values: {
        scheduledStart: new Date(now.getTime() + DAY_MS),
        scheduledEnd: new Date(now.getTime() + DAY_MS + HOUR_MS),
        deletedAt: now,
      },
    });

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagement.id],
      now
    );
    expect(result.get(engagement.id)).toEqual({
      lastCompletedConsultationAt: null,
      nextScheduledConsultationAt: null,
    });
  });

  it('BATCHES — 3 ids in, 3 entries out, each resolved independently', async () => {
    const now = new Date();
    const withCompleted = (await caseEngagementFactory()).engagement.id;
    const withUpcoming = (await caseEngagementFactory()).engagement.id;
    const withNeither = (await caseEngagementFactory()).engagement.id;
    const endedAt = new Date(now.getTime() - DAY_MS);
    const upcoming = new Date(now.getTime() + DAY_MS);

    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: withCompleted }],
      values: { status: 'ended', outcome: 'completed', endedAt },
    });
    await meetingFactory({
      contexts: [{ contextType: 'case', contextId: withUpcoming }],
      values: { scheduledStart: upcoming, scheduledEnd: new Date(upcoming.getTime() + HOUR_MS) },
    });

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [withCompleted, withUpcoming, withNeither],
      now
    );

    expect(result.size).toBe(3);
    expect(result.get(withCompleted)?.lastCompletedConsultationAt?.getTime()).toBe(
      endedAt.getTime()
    );
    expect(result.get(withCompleted)?.nextScheduledConsultationAt).toBeNull();
    expect(result.get(withUpcoming)?.nextScheduledConsultationAt?.getTime()).toBe(
      upcoming.getTime()
    );
    expect(result.get(withUpcoming)?.lastCompletedConsultationAt).toBeNull();
    expect(result.get(withNeither)).toEqual({
      lastCompletedConsultationAt: null,
      nextScheduledConsultationAt: null,
    });
  });

  it('a NON-case context (project_kickoff) on the same id does not leak into the case read', async () => {
    const { engagement } = await caseEngagementFactory();
    const now = new Date();

    await meetingFactory({
      contexts: [{ contextType: 'project_kickoff', contextId: engagement.id }],
      values: {
        status: 'ended',
        outcome: 'completed',
        endedAt: new Date(now.getTime() - DAY_MS),
      },
    });

    const result = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagement.id],
      now
    );
    expect(result.get(engagement.id)?.lastCompletedConsultationAt).toBeNull();
  });
});

/**
 * CASE INACTIVITY COMPOSITION (BAL-417 × BAL-418), on behalf of BAL-425.
 *
 * ⚠ THIS IS A COMPOSITION TEST, NOT A SWEEP. BAL-417's auto-close is a WINDOW-MATH sweep
 * and is NOT a consumer of BAL-420's `schedule()` primitive — there is no per-instance
 * promise to cancel, because a candidate simply stops matching the query when the case
 * gets activity. BAL-425 stays OPEN: no sweep file, no cron registration, no feature flag,
 * and its mid-call `in_progress` hazard decision is untouched. What this proves is only
 * that the two SHIPPED pieces the sweep will stand on compose to the right answer:
 *
 *     meetingContextsRepository.consultationTimestampsForEngagements(ids, now)   [BAL-418]
 *       ──feeds──▶  isCaseInactive({ caseCreatedAt, ...anchors, now })           [BAL-417]
 *
 * `caseEngagementsRepository.listOpenCreatedBefore` returns only the SQL-expressible,
 * creation-anchored, consultation-BLIND superset; this pair is the refinement, and it can
 * only refine what it is handed.
 */
describe('case inactivity composition (BAL-417 × BAL-418)', () => {
  /** Resolve both anchors for one case and apply the rule, exactly as the sweep will. */
  async function inactive(engagementId: string, caseCreatedAt: Date, now: Date): Promise<boolean> {
    const anchors = await meetingContextsRepository.consultationTimestampsForEngagements(
      [engagementId],
      now
    );
    const timestamps = anchors.get(engagementId);
    if (timestamps === undefined) {
      throw new Error(`consultationTimestampsForEngagements dropped ${engagementId}`);
    }
    return isCaseInactive({
      now,
      caseCreatedAt,
      lastCompletedConsultationAt: timestamps.lastCompletedConsultationAt,
      nextScheduledConsultationAt: timestamps.nextScheduledConsultationAt,
    });
  }

  const NOW = new Date('2026-08-05T12:00:00.000Z');
  const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);
  const daysAhead = (days: number): Date => new Date(NOW.getTime() + days * DAY_MS);

  it('1 — created 31d ago with NO meeting contexts at all ⇒ INACTIVE', async () => {
    const { engagement } = await caseEngagementFactory({ values: { createdAt: daysAgo(31) } });

    // The map still returns an entry (both anchors null), so the rule falls back to the
    // creation anchor — "absent" never has to be distinguished from "none".
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

  it('3b — ⚠ PASSING `null, null` FLIPS CASE 3 TO INACTIVE. That is the whole point of this test.', async () => {
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
