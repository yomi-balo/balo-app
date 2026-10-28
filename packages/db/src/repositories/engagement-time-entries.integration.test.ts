import { describe, it, expect } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  auditEvents,
  engagementMilestones,
  engagementTimeEntries,
  type AuditEvent,
  type EngagementMilestone,
} from '../schema';
import {
  engagementFactory,
  engagementMilestoneFactory,
  engagementTimeEntryFactory,
  userFactory,
} from '../test/factories';
import {
  engagementTimeEntriesRepository as repo,
  loggedMinutesTx,
  TimeEntryWriteRefusedError,
  type TimeEntryRefusal,
} from './engagement-time-entries';
import { engagementChangeOrdersRepository } from './engagement-change-orders';
import { EngagementNotActiveError } from './_shared/engagement-lock';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';

const TODAY = new Date().toISOString().slice(0, 10);

type ProjectOverrides = NonNullable<Parameters<typeof engagementFactory>[0]>;

/** An active T&M project with one in-progress milestone (8-hour estimate) and an expert user. */
async function seedTm(
  options: {
    project?: ProjectOverrides;
    milestone?: Partial<EngagementMilestone>;
  } = {}
): Promise<{ engagementId: string; userId: string; milestone: EngagementMilestone }> {
  const { engagement } = await engagementFactory({
    ...options.project,
    projectValues: {
      pricingMethod: 'tm',
      priceCents: 1_000_000,
      rateCents: 15_000,
      cadence: 'monthly',
      ...options.project?.projectValues,
    },
  });
  const { milestone } = await engagementMilestoneFactory({
    engagementId: engagement.id,
    values: { status: 'in_progress', estimatedMinutes: 480, ...options.milestone },
  });
  const user = await userFactory({ firstName: 'Priya' });
  return { engagementId: engagement.id, userId: user.id, milestone };
}

async function crossingAudits(milestoneId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityId, milestoneId),
        eq(auditEvents.action, 'engagement_milestone.estimate_exceeded')
      )
    )
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.seq));
}

async function auditFor(entityId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.seq));
}

async function entriesOn(milestoneId: string): Promise<number> {
  const rows = await db
    .select({ id: engagementTimeEntries.id })
    .from(engagementTimeEntries)
    .where(eq(engagementTimeEntries.engagementMilestoneId, milestoneId));
  return rows.length;
}

async function refusalOf(attempt: Promise<unknown>): Promise<TimeEntryRefusal> {
  const error: unknown = await attempt.then(
    () => null,
    (e: unknown) => e
  );
  if (!(error instanceof TimeEntryWriteRefusedError)) {
    throw new Error(`Expected TimeEntryWriteRefusedError, got ${String(error)}`);
  }
  return error.reason;
}

function logInput(
  seeded: { engagementId: string; userId: string; milestone: { id: string } },
  minutes: number
): Parameters<typeof repo.log>[0] {
  return {
    engagementId: seeded.engagementId,
    milestoneId: seeded.milestone.id,
    userId: seeded.userId,
    minutes,
    note: 'Built the lead routing flow.',
    workedOn: TODAY,
  };
}

describe('engagement_time_entries constraints', () => {
  it('rejects zero minutes and a blank note', async () => {
    const seeded = await seedTm();
    const row = {
      engagementId: seeded.engagementId,
      engagementMilestoneId: seeded.milestone.id,
      userId: seeded.userId,
      workedOn: TODAY,
    };

    await expectConstraintViolation(
      '23514',
      (tx) => tx.insert(engagementTimeEntries).values({ ...row, minutes: 0, note: 'Work' }),
      'engagement_time_entry_minutes_positive'
    );
    await expectConstraintViolation(
      '23514',
      (tx) => tx.insert(engagementTimeEntries).values({ ...row, minutes: 15, note: '   ' }),
      'engagement_time_entry_note_present'
    );
  });
});

describe('engagementTimeEntriesRepository.log', () => {
  it('leaves updatedByUserId null: a logged entry has never been edited', async () => {
    const seeded = await seedTm();

    const { entry } = await repo.log(logInput(seeded, 60));

    expect(entry.updatedByUserId).toBeNull();
  });

  it('inserts the entry and returns the milestone total', async () => {
    const seeded = await seedTm();

    const result = await repo.log(logInput(seeded, 90));

    expect(result.entry).toMatchObject({
      engagementId: seeded.engagementId,
      engagementMilestoneId: seeded.milestone.id,
      userId: seeded.userId,
      minutes: 90,
      workedOn: TODAY,
      note: 'Built the lead routing flow.',
      deletedAt: null,
    });
    expect(result.milestone).toEqual({
      id: seeded.milestone.id,
      title: seeded.milestone.title,
      estimatedMinutes: 480,
    });
    expect(result.loggedAfterMinutes).toBe(90);
    expect(result.estimateExceeded).toBe(false);
    expect(result.milestonesOverCount).toBe(0);
    expect(await crossingAudits(seeded.milestone.id)).toEqual([]);
  });

  it('audits the insert in the same transaction', async () => {
    const seeded = await seedTm();

    const { entry } = await repo.log(logInput(seeded, 90));

    const events = await auditFor(entry.id);
    expect(events.map((e) => e.action)).toEqual(['engagement_time_entry.logged']);
    expect(events[0]?.entityType).toBe('engagement_time_entry');
    expect(events[0]?.actorUserId).toBe(seeded.userId);
    expect(events[0]?.metadata).toEqual({
      milestoneId: seeded.milestone.id,
      minutes: 90,
      workedOn: TODAY,
      engagementId: seeded.engagementId,
    });
  });

  it('rolls back the entry when its audit fails', async () => {
    const seeded = await seedTm();
    await db.execute(sql`
      CREATE FUNCTION bal624_fail_logged() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced failure on the logged audit';
      END;
      $$
    `);
    await db.execute(sql`
      CREATE TRIGGER bal624_fail_logged BEFORE INSERT ON audit_events
      FOR EACH ROW WHEN (NEW.action = 'engagement_time_entry.logged')
      EXECUTE FUNCTION bal624_fail_logged()
    `);

    await expect(repo.log(logInput(seeded, 60))).rejects.toThrow(
      'forced failure on the logged audit'
    );

    expect(await entriesOn(seeded.milestone.id)).toBe(0);
  });

  it('refuses a fixed-price project and writes nothing', async () => {
    const seeded = await seedTm({ project: { projectValues: { pricingMethod: 'fixed' } } });

    expect(await refusalOf(repo.log(logInput(seeded, 60)))).toBe('not_time_and_materials');
    expect(await entriesOn(seeded.milestone.id)).toBe(0);
  });

  it('refuses a project in pending_acceptance', async () => {
    const seeded = await seedTm({
      project: { projectValues: { deliveryStatus: 'pending_acceptance' } },
    });

    await expect(repo.log(logInput(seeded, 60))).rejects.toBeInstanceOf(EngagementNotActiveError);
    expect(await entriesOn(seeded.milestone.id)).toBe(0);
  });

  it.each(['pending', 'completed'] as const)('refuses a %s milestone', async (status) => {
    const seeded = await seedTm({ milestone: { status } });

    expect(await refusalOf(repo.log(logInput(seeded, 60)))).toBe('milestone_not_in_progress');
    expect(await entriesOn(seeded.milestone.id)).toBe(0);
  });

  it('refuses a milestone of another engagement, or a removed one', async () => {
    const seeded = await seedTm();
    const other = await seedTm();
    const removed = await seedTm({ milestone: { deletedAt: new Date() } });

    expect(
      await refusalOf(repo.log({ ...logInput(seeded, 60), milestoneId: other.milestone.id }))
    ).toBe('milestone_not_found');
    expect(await refusalOf(repo.log(logInput(removed, 60)))).toBe('milestone_not_found');
    expect(await entriesOn(other.milestone.id)).toBe(0);
  });

  it('flags and audits the first crossing of the estimate, and only the first', async () => {
    const seeded = await seedTm();
    await repo.log(logInput(seeded, 465)); // 7.75 hours of 8

    const crossing = await repo.log(logInput(seeded, 30)); // 8.25 hours

    expect(crossing.estimateExceeded).toBe(true);
    expect(crossing.loggedAfterMinutes).toBe(495);
    expect(crossing.milestonesOverCount).toBe(1);
    const [audit, ...rest] = await crossingAudits(seeded.milestone.id);
    expect(rest).toEqual([]);
    expect(audit?.entityType).toBe('engagement_milestone');
    expect(audit?.actorUserId).toBe(seeded.userId);
    expect(audit?.metadata).toEqual({
      estimatedMinutes: 480,
      loggedMinutes: 495,
      timeEntryId: crossing.entry.id,
      engagementId: seeded.engagementId,
    });

    const next = await repo.log(logInput(seeded, 15));

    expect(next.estimateExceeded).toBe(false);
    expect(next.milestonesOverCount).toBe(1);
    expect(await crossingAudits(seeded.milestone.id)).toHaveLength(1);
  });

  it('does not flag again when an entry is removed and relogged at the same estimate', async () => {
    const seeded = await seedTm();
    await repo.log(logInput(seeded, 465));
    const crossing = await repo.log(logInput(seeded, 30));
    await repo.remove({
      authorScope: 'own',
      engagementId: seeded.engagementId,
      entryId: crossing.entry.id,
      userId: seeded.userId,
    });

    const relog = await repo.log(logInput(seeded, 30));

    expect(relog.estimateExceeded).toBe(false);
    expect(await crossingAudits(seeded.milestone.id)).toHaveLength(1);
  });

  it('flags again once an approved change order raises the estimate and it is crossed', async () => {
    const seeded = await seedTm();
    await repo.log(logInput(seeded, 495));
    const order = await engagementChangeOrdersRepository.createDraft({
      engagementId: seeded.engagementId,
      userId: seeded.userId,
      note: 'The integration needs two more hours.',
      newTotalCents: null,
      lines: [
        {
          op: 'edit',
          engagementMilestoneId: seeded.milestone.id,
          title: seeded.milestone.title,
          descriptionHtml: null,
          acceptanceCriteria: null,
          valueCents: null,
          estimatedMinutes: 600,
        },
      ],
    });
    await engagementChangeOrdersRepository.send({
      engagementId: seeded.engagementId,
      orderId: order.id,
      userId: seeded.userId,
    });
    await engagementChangeOrdersRepository.approve({
      engagementId: seeded.engagementId,
      orderId: order.id,
      userId: seeded.userId,
    });

    const within = await repo.log(logInput(seeded, 105)); // exactly 600
    const crossing = await repo.log(logInput(seeded, 15));

    expect(within.estimateExceeded).toBe(false);
    expect(crossing.estimateExceeded).toBe(true);
    const audits = await crossingAudits(seeded.milestone.id);
    expect(audits.map((a) => a.metadata?.estimatedMinutes)).toEqual([480, 600]);
  });

  it('treats an estimate of 0 as real: the first entry crosses it', async () => {
    const seeded = await seedTm({ milestone: { estimatedMinutes: 0 } });

    const result = await repo.log(logInput(seeded, 15));

    expect(result.estimateExceeded).toBe(true);
    expect(result.milestonesOverCount).toBe(1);
  });

  it('never flags a milestone with no estimate', async () => {
    const seeded = await seedTm({ milestone: { estimatedMinutes: null } });

    const result = await repo.log(logInput(seeded, 1440));

    expect(result.estimateExceeded).toBe(false);
    expect(result.milestonesOverCount).toBe(0);
    expect(await crossingAudits(seeded.milestone.id)).toEqual([]);
  });

  it('rolls back the entry when the crossing audit fails, leaving no audit row', async () => {
    const seeded = await seedTm();
    await repo.log(logInput(seeded, 480));
    await db.execute(sql`
      CREATE FUNCTION bal624_fail_crossing() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced failure on the crossing audit';
      END;
      $$
    `);
    await db.execute(sql`
      CREATE TRIGGER bal624_fail_crossing BEFORE INSERT ON audit_events
      FOR EACH ROW WHEN (NEW.action = 'engagement_milestone.estimate_exceeded')
      EXECUTE FUNCTION bal624_fail_crossing()
    `);

    await expect(repo.log(logInput(seeded, 15))).rejects.toThrow(
      'forced failure on the crossing audit'
    );

    expect(await entriesOn(seeded.milestone.id)).toBe(1);
    expect(await crossingAudits(seeded.milestone.id)).toEqual([]);
  });
});

describe('engagementTimeEntriesRepository.update', () => {
  it('changes the minutes and note and audits the edit', async () => {
    const seeded = await seedTm();
    const { entry } = await repo.log(logInput(seeded, 60));

    const result = await repo.update({
      authorScope: 'own',
      engagementId: seeded.engagementId,
      entryId: entry.id,
      userId: seeded.userId,
      minutes: 75,
      note: 'Built and tested the routing flow.',
    });

    expect(result.entry).toMatchObject({ id: entry.id, minutes: 75 });
    expect(result.entry.note).toBe('Built and tested the routing flow.');
    expect(result.loggedAfterMinutes).toBe(75);
    expect(result.estimateExceeded).toBe(false);
    const events = await auditFor(entry.id);
    expect(events.map((e) => e.action)).toEqual([
      'engagement_time_entry.logged',
      'engagement_time_entry.edited',
    ]);
    expect(events[1]?.entityType).toBe('engagement_time_entry');
    expect(events[1]?.metadata).toEqual({
      fromMinutes: 60,
      toMinutes: 75,
      noteChanged: true,
      engagementId: seeded.engagementId,
    });
  });

  it('flags a crossing caused by the edit', async () => {
    const seeded = await seedTm();
    await repo.log(logInput(seeded, 420));
    const { entry } = await repo.log(logInput(seeded, 60)); // exactly 480

    const result = await repo.update({
      authorScope: 'own',
      engagementId: seeded.engagementId,
      entryId: entry.id,
      userId: seeded.userId,
      minutes: 90,
      note: entry.note,
    });

    expect(result.loggedAfterMinutes).toBe(510);
    expect(result.estimateExceeded).toBe(true);
    const [audit] = await crossingAudits(seeded.milestone.id);
    expect(audit?.metadata).toMatchObject({ estimatedMinutes: 480, loggedMinutes: 510 });
    const [, edited] = await auditFor(entry.id);
    expect(edited?.action).toBe('engagement_time_entry.edited');
    expect(edited?.metadata).toMatchObject({ noteChanged: false });
  });

  it('refuses another author, a removed entry and another engagement alike', async () => {
    const seeded = await seedTm();
    const other = await seedTm();
    const { entry } = await repo.log(logInput(seeded, 60));
    const { entry: removed } = await engagementTimeEntryFactory({
      milestone: seeded.milestone,
      userId: seeded.userId,
      values: { deletedAt: new Date() },
    });
    const base = { minutes: 30, note: 'Changed', authorScope: 'own' as const };

    const attempts = [
      { engagementId: seeded.engagementId, entryId: entry.id, userId: other.userId },
      { engagementId: seeded.engagementId, entryId: removed.id, userId: seeded.userId },
      { engagementId: other.engagementId, entryId: entry.id, userId: seeded.userId },
    ];
    for (const attempt of attempts) {
      expect(await refusalOf(repo.update({ ...attempt, ...base }))).toBe('entry_not_found');
    }
    const [unchanged] = await db
      .select()
      .from(engagementTimeEntries)
      .where(eq(engagementTimeEntries.id, entry.id));
    expect(unchanged?.minutes).toBe(60);
  });

  it("lets scope 'any' edit another author's entry, auditing the editor as actor", async () => {
    const seeded = await seedTm();
    const editor = await userFactory();
    const { entry } = await repo.log(logInput(seeded, 60));

    const result = await repo.update({
      engagementId: seeded.engagementId,
      entryId: entry.id,
      userId: editor.id,
      authorScope: 'any',
      minutes: 90,
      note: 'Corrected by the agency.',
    });

    expect(result.entry).toMatchObject({ id: entry.id, minutes: 90, userId: seeded.userId });
    const [, edited] = await auditFor(entry.id);
    expect(edited?.actorUserId).toBe(editor.id);
  });

  it('stamps the acting user as updatedByUserId when someone else edits', async () => {
    const seeded = await seedTm();
    const editor = await userFactory();
    const { entry } = await repo.log(logInput(seeded, 60));

    const result = await repo.update({
      engagementId: seeded.engagementId,
      entryId: entry.id,
      userId: editor.id,
      authorScope: 'any',
      minutes: 90,
      note: 'Corrected by the agency.',
    });

    expect(result.entry.updatedByUserId).toBe(editor.id);
    expect(result.entry.userId).toBe(seeded.userId);
  });

  it('stamps the author as updatedByUserId on a self-edit', async () => {
    const seeded = await seedTm();
    const { entry } = await repo.log(logInput(seeded, 60));

    const result = await repo.update({
      engagementId: seeded.engagementId,
      entryId: entry.id,
      userId: seeded.userId,
      authorScope: 'own',
      minutes: 75,
      note: 'Built and tested the routing flow.',
    });

    expect(result.entry.updatedByUserId).toBe(seeded.userId);
  });

  it("checks the daily limit against the entry's author for scope 'any'", async () => {
    const seeded = await seedTm();
    const editor = await userFactory();
    await repo.log(logInput(seeded, 1000));
    const { entry } = await repo.log(logInput(seeded, 400));
    await engagementTimeEntryFactory({
      milestone: seeded.milestone,
      userId: editor.id,
      values: { minutes: 1440 },
    });
    const update = (minutes: number) =>
      repo.update({
        engagementId: seeded.engagementId,
        entryId: entry.id,
        userId: editor.id,
        authorScope: 'any',
        minutes,
        note: entry.note,
      });

    expect((await update(440)).entry.minutes).toBe(440);
    expect(await refusalOf(update(441))).toBe('daily_limit_exceeded');
  });

  it("does not let scope 'any' reach another engagement's entry", async () => {
    const seeded = await seedTm();
    const other = await seedTm();
    const { entry } = await repo.log(logInput(seeded, 60));

    expect(
      await refusalOf(
        repo.update({
          engagementId: other.engagementId,
          entryId: entry.id,
          userId: other.userId,
          authorScope: 'any',
          minutes: 30,
          note: 'Changed',
        })
      )
    ).toBe('entry_not_found');
  });

  it('refuses an entry on a milestone that is no longer in progress', async () => {
    const seeded = await seedTm();
    const { entry } = await repo.log(logInput(seeded, 60));
    await db
      .update(engagementMilestones)
      .set({ status: 'completed' })
      .where(eq(engagementMilestones.id, seeded.milestone.id));

    expect(
      await refusalOf(
        repo.update({
          authorScope: 'own',
          engagementId: seeded.engagementId,
          entryId: entry.id,
          userId: seeded.userId,
          minutes: 30,
          note: 'Changed',
        })
      )
    ).toBe('milestone_not_in_progress');
  });
});

describe('engagementTimeEntriesRepository.remove', () => {
  it('stamps the remover as updatedByUserId', async () => {
    const seeded = await seedTm();
    const remover = await userFactory();
    const { entry } = await repo.log(logInput(seeded, 45));

    const removed = await repo.remove({
      engagementId: seeded.engagementId,
      entryId: entry.id,
      userId: remover.id,
      authorScope: 'any',
    });

    expect(removed.updatedByUserId).toBe(remover.id);
  });

  it('soft-deletes the entry on a milestone in any status and audits it', async () => {
    const seeded = await seedTm();
    const { entry } = await repo.log(logInput(seeded, 45));
    await db
      .update(engagementMilestones)
      .set({ status: 'completed' })
      .where(eq(engagementMilestones.id, seeded.milestone.id));

    const removed = await repo.remove({
      authorScope: 'own',
      engagementId: seeded.engagementId,
      entryId: entry.id,
      userId: seeded.userId,
    });

    expect(removed.deletedAt).toBeInstanceOf(Date);
    expect(await loggedMinutesTx(db, seeded.engagementId)).toBe(0);
    const events = await auditFor(entry.id);
    expect(events.map((e) => e.action)).toEqual([
      'engagement_time_entry.logged',
      'engagement_time_entry.removed',
    ]);
    expect(events[1]?.metadata).toEqual({ minutes: 45, engagementId: seeded.engagementId });
  });

  it("refuses another author's entry and an already removed one", async () => {
    const seeded = await seedTm();
    const other = await userFactory();
    const { entry } = await repo.log(logInput(seeded, 45));

    expect(
      await refusalOf(
        repo.remove({
          engagementId: seeded.engagementId,
          entryId: entry.id,
          userId: other.id,
          authorScope: 'own',
        })
      )
    ).toBe('entry_not_found');
    await repo.remove({
      authorScope: 'own',
      engagementId: seeded.engagementId,
      entryId: entry.id,
      userId: seeded.userId,
    });
    expect(
      await refusalOf(
        repo.remove({
          engagementId: seeded.engagementId,
          entryId: entry.id,
          userId: seeded.userId,
          authorScope: 'own',
        })
      )
    ).toBe('entry_not_found');
  });

  it("lets scope 'any' remove another author's entry, auditing the remover as actor", async () => {
    const seeded = await seedTm();
    const remover = await userFactory();
    const { entry } = await repo.log(logInput(seeded, 45));

    const removed = await repo.remove({
      engagementId: seeded.engagementId,
      entryId: entry.id,
      userId: remover.id,
      authorScope: 'any',
    });

    expect(removed.deletedAt).toBeInstanceOf(Date);
    const [, event] = await auditFor(entry.id);
    expect(event?.actorUserId).toBe(remover.id);
  });

  it("does not let scope 'any' reach another engagement's entry", async () => {
    const seeded = await seedTm();
    const other = await seedTm();
    const { entry } = await repo.log(logInput(seeded, 45));

    expect(
      await refusalOf(
        repo.remove({
          engagementId: other.engagementId,
          entryId: entry.id,
          userId: other.userId,
          authorScope: 'any',
        })
      )
    ).toBe('entry_not_found');
  });

  it('refuses once the project has left active', async () => {
    const seeded = await seedTm({
      project: { projectValues: { deliveryStatus: 'pending_acceptance' } },
    });
    const { entry } = await engagementTimeEntryFactory({
      milestone: seeded.milestone,
      userId: seeded.userId,
    });

    await expect(
      repo.remove({
        engagementId: seeded.engagementId,
        entryId: entry.id,
        userId: seeded.userId,
        authorScope: 'own',
      })
    ).rejects.toBeInstanceOf(EngagementNotActiveError);
  });
});

describe('engagementTimeEntriesRepository.listByEngagement', () => {
  it('lists live entries newest work date first, with the author first name', async () => {
    const seeded = await seedTm();
    const older = await engagementTimeEntryFactory({
      milestone: seeded.milestone,
      userId: seeded.userId,
      values: { workedOn: '2026-10-01' },
    });
    const newer = await engagementTimeEntryFactory({
      milestone: seeded.milestone,
      userId: seeded.userId,
      values: { workedOn: '2026-10-20' },
    });
    await engagementTimeEntryFactory({
      milestone: seeded.milestone,
      userId: seeded.userId,
      values: { workedOn: '2026-10-25', deletedAt: new Date() },
    });

    const rows = await repo.listByEngagement(seeded.engagementId);

    expect(rows.map((r) => r.id)).toEqual([newer.entry.id, older.entry.id]);
    expect(rows[0]).toMatchObject({
      engagementMilestoneId: seeded.milestone.id,
      userId: seeded.userId,
      authorFirstName: 'Priya',
      workedOn: '2026-10-20',
      minutes: 60,
    });
  });
});

describe('engagementTimeEntriesRepository.listByEngagement — editor', () => {
  it('returns the editor name only, with exactly the added keys, and nulls for a never-edited entry', async () => {
    const seeded = await seedTm();
    const editor = await userFactory({ firstName: 'Dana', lastName: 'Whitfield' });
    const edited = await repo.log(logInput(seeded, 60));
    await repo.update({
      engagementId: seeded.engagementId,
      entryId: edited.entry.id,
      userId: editor.id,
      authorScope: 'any',
      minutes: 90,
      note: 'Corrected by the agency.',
    });
    const untouched = await engagementTimeEntryFactory({
      milestone: seeded.milestone,
      userId: seeded.userId,
      values: { workedOn: '2026-01-01' },
    });

    const rows = await repo.listByEngagement(seeded.engagementId);

    const editedRow = rows.find((r) => r.id === edited.entry.id);
    expect(editedRow).toMatchObject({
      updatedByUserId: editor.id,
      editorFirstName: 'Dana',
      editorLastName: 'Whitfield',
    });
    expect(Object.keys(editedRow ?? {}).sort()).toEqual(
      [
        'id',
        'engagementMilestoneId',
        'userId',
        'authorFirstName',
        'updatedByUserId',
        'editorFirstName',
        'editorLastName',
        'workedOn',
        'minutes',
        'note',
        'createdAt',
      ].sort()
    );
    expect(rows.find((r) => r.id === untouched.entry.id)).toMatchObject({
      updatedByUserId: null,
      editorFirstName: null,
      editorLastName: null,
    });
  });
});

describe('engagementTimeEntriesRepository.sumsForEngagement', () => {
  it('sums the total, per milestone (removed milestones included) and the billing window', async () => {
    const seeded = await seedTm();
    const { milestone: gone } = await engagementMilestoneFactory({
      engagementId: seeded.engagementId,
      values: { sortOrder: 1, status: 'in_progress', deletedAt: new Date() },
    });
    const at = (
      milestone: { id: string; engagementId: string },
      workedOn: string,
      minutes: number
    ) =>
      engagementTimeEntryFactory({
        milestone,
        userId: seeded.userId,
        values: { workedOn, minutes },
      });
    await at(seeded.milestone, '2026-09-30', 15); // before the window
    await at(seeded.milestone, '2026-10-01', 30); // on startOn: counts
    await at(gone, '2026-10-15', 45);
    await at(seeded.milestone, '2026-11-01', 60); // on endOn: excluded
    await engagementTimeEntryFactory({
      milestone: seeded.milestone,
      userId: seeded.userId,
      values: { workedOn: '2026-10-10', minutes: 120, deletedAt: new Date() },
    });

    const sums = await repo.sumsForEngagement(seeded.engagementId, {
      startOn: '2026-10-01',
      endOn: '2026-11-01',
    });

    expect(sums).toEqual({
      totalMinutes: 150,
      periodMinutes: 75,
      byMilestone: { [seeded.milestone.id]: 105, [gone.id]: 45 },
    });
    expect(await loggedMinutesTx(db, seeded.engagementId)).toBe(150);
  });

  it('returns a null period sum without a period, and zeros with no entries', async () => {
    const seeded = await seedTm();

    expect(await repo.sumsForEngagement(seeded.engagementId, null)).toEqual({
      totalMinutes: 0,
      periodMinutes: null,
      byMilestone: {},
    });
  });
});

describe('engagementTimeEntriesRepository.listNotifiedAtCurrentEstimate', () => {
  it('lists a milestone once its notice is sent, and drops it when the estimate changes', async () => {
    const seeded = await seedTm(); // 8h estimate
    expect(await repo.listNotifiedAtCurrentEstimate(seeded.engagementId)).toEqual([]);

    await repo.log(logInput(seeded, 465));
    expect(await repo.listNotifiedAtCurrentEstimate(seeded.engagementId)).toEqual([]);

    await repo.log(logInput(seeded, 30)); // crosses 8h
    expect(await repo.listNotifiedAtCurrentEstimate(seeded.engagementId)).toEqual([
      seeded.milestone.id,
    ]);

    await db
      .update(engagementMilestones)
      .set({ estimatedMinutes: 600 })
      .where(eq(engagementMilestones.id, seeded.milestone.id));
    expect(await repo.listNotifiedAtCurrentEstimate(seeded.engagementId)).toEqual([]);
  });
});

describe('engagementTimeEntriesRepository.listOverEstimateForAlerts', () => {
  async function seedWithLogged(
    logged: number,
    options: Parameters<typeof seedTm>[0] = {}
  ): Promise<string> {
    const seeded = await seedTm(options);
    await engagementTimeEntryFactory({
      milestone: seeded.milestone,
      userId: seeded.userId,
      values: { minutes: logged },
    });
    return seeded.engagementId;
  }

  async function listedAmong(ids: readonly string[]): Promise<string[]> {
    const rows = await repo.listOverEstimateForAlerts(1000);
    return rows.map((r) => r.engagementId).filter((id) => ids.includes(id));
  }

  it('lists active T&M projects over their total estimate, furthest over first', async () => {
    const slightly = await seedWithLogged(500);
    const far = await seedWithLogged(900);

    const rows = (await repo.listOverEstimateForAlerts(1000)).filter((r) =>
      [slightly, far].includes(r.engagementId)
    );

    expect(rows.map((r) => r.engagementId)).toEqual([far, slightly]);
    expect(rows[0]).toMatchObject({
      clientCompanyName: 'Acme Co',
      loggedMinutes: 900,
      estimatedMinutes: 480,
      agencyName: null,
    });
  });

  it('compares only time on live milestones that have an estimate', async () => {
    const seeded = await seedTm(); // one live milestone, 8h estimate
    const { milestone: unestimated } = await engagementMilestoneFactory({
      engagementId: seeded.engagementId,
      values: { sortOrder: 1, estimatedMinutes: null },
    });
    const { milestone: gone } = await engagementMilestoneFactory({
      engagementId: seeded.engagementId,
      values: { sortOrder: 2, estimatedMinutes: 600, deletedAt: new Date() },
    });
    await engagementTimeEntryFactory({
      milestone: seeded.milestone,
      userId: seeded.userId,
      values: { minutes: 300 },
    });
    await engagementTimeEntryFactory({
      milestone: unestimated,
      userId: seeded.userId,
      values: { minutes: 600 },
    });
    await engagementTimeEntryFactory({
      milestone: gone,
      userId: seeded.userId,
      values: { minutes: 240 },
    });

    // 1,140 minutes logged in all, but only 300 against the 480-minute estimate.
    expect(await listedAmong([seeded.engagementId])).toEqual([]);

    await engagementTimeEntryFactory({
      milestone: seeded.milestone,
      userId: seeded.userId,
      values: { minutes: 181 },
    });
    expect(await listedAmong([seeded.engagementId])).toEqual([seeded.engagementId]);
  });

  it('leaves out equal, fixed-price, pending-acceptance and estimate-free projects', async () => {
    const equal = await seedWithLogged(480);
    const fixed = await seedWithLogged(900, {
      project: { projectValues: { pricingMethod: 'fixed' } },
    });
    const pending = await seedWithLogged(900, {
      project: { projectValues: { deliveryStatus: 'pending_acceptance' } },
    });
    const noEstimate = await seedWithLogged(900, { milestone: { estimatedMinutes: null } });

    expect(await listedAmong([equal, fixed, pending, noEstimate])).toEqual([]);
  });

  it('honours the limit', async () => {
    await seedWithLogged(900);
    await seedWithLogged(901);

    expect(await repo.listOverEstimateForAlerts(1)).toHaveLength(1);
  });
});

describe('engagementTimeEntriesRepository — daily limit per author', () => {
  it('accepts exactly a day on one date across milestones, and refuses one minute more', async () => {
    const seeded = await seedTm();
    const { milestone: second } = await engagementMilestoneFactory({
      engagementId: seeded.engagementId,
      values: { sortOrder: 1, status: 'in_progress', estimatedMinutes: 480 },
    });
    await engagementTimeEntryFactory({
      milestone: second,
      userId: seeded.userId,
      values: { minutes: 1000 },
    });

    await repo.log(logInput(seeded, 440)); // 1440 on the day
    expect(await refusalOf(repo.log(logInput(seeded, 1)))).toBe('daily_limit_exceeded');
  });

  it('counts only the author, the date and live entries', async () => {
    const seeded = await seedTm();
    const colleague = await userFactory();
    const at = (userId: string, values: { workedOn?: string; deletedAt?: Date }) =>
      engagementTimeEntryFactory({
        milestone: seeded.milestone,
        userId,
        values: { minutes: 1440, ...values },
      });
    await at(colleague.id, {});
    await at(seeded.userId, { workedOn: '2026-01-01' });
    await at(seeded.userId, { deletedAt: new Date() });

    const result = await repo.log(logInput(seeded, 1440));

    expect(result.entry.minutes).toBe(1440);
  });

  it("excludes the edited entry's old minutes on update", async () => {
    const seeded = await seedTm();
    await repo.log(logInput(seeded, 1000));
    const { entry } = await repo.log(logInput(seeded, 400));
    const update = (minutes: number) =>
      repo.update({
        authorScope: 'own',
        engagementId: seeded.engagementId,
        entryId: entry.id,
        userId: seeded.userId,
        minutes,
        note: entry.note,
      });

    expect((await update(440)).entry.minutes).toBe(440);
    expect(await refusalOf(update(441))).toBe('daily_limit_exceeded');
  });
});
