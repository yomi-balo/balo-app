import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, ne, sql, sum } from 'drizzle-orm';
import { estimateCrossed, TIME_ENTRY_MAX_MINUTES, type IsoDate } from '@balo/shared/engagements';
import { db } from '../client';
import {
  agencies,
  auditEvents,
  companies,
  engagementMilestones,
  engagements,
  engagementTimeEntries,
  expertProfiles,
  projectEngagements,
  projectRequests,
  users,
  type EngagementMilestone,
  type EngagementTimeEntry,
} from '../schema';
import { recordDeliveryAudit } from './_shared/delivery-audit';
import { lockEngagementAndMilestone, type DbTx } from './_shared/engagement-lock';
import { readProjectTermsTx } from './_shared/change-order-guards';
import type { DbExecutor } from './_shared/db-executor';

/**
 * The time-entry repository: time an expert logs against the milestones of a live
 * time-and-materials project, and the sums the workspace and the admin finder read.
 *
 * LOCK DANCE (fenced by `time-entry-writers-take-the-engagement-lock-first.test.ts`): every
 * write transaction opens with `lockEngagementAndMilestone`, so time writes serialise with
 * every other delivery write on the engagement — including a change order's `send` and
 * `approve`, which read the logged total under the same lock for `cap_below_logged`. Lock
 * order: engagement → project child → milestone → entry. The entry's milestone is discovered
 * by an unlocked read before the transaction; the guards run against the locked re-reads.
 *
 * WRITE PRECONDITIONS. The project is `active` (so `pending_acceptance` is refused by the lock)
 * and priced `tm`. `log` and `update` need the milestone `in_progress` and keep the author's
 * live minutes on the work date, across the engagement, within a day (`TIME_ENTRY_MAX_MINUTES`);
 * `remove` works on a milestone in any status. `update` and `remove` act only on the caller's
 * own live entry.
 *
 * ESTIMATE CROSSING. A write that moves a milestone's live logged total from within its
 * estimate to beyond it records `engagement_milestone.estimate_exceeded` in the same
 * transaction — once per milestone per estimate value (the value is kept in the audit
 * metadata), so removing and relogging at the same estimate does not record it again, while a
 * change order that raises the estimate re-arms it. The returned `estimateExceeded` flag tells
 * the caller to notify.
 *
 * ROLE-FREE. The web layer decides who may log (the engagement axis); `userId` is the actor.
 *
 * NEVER NOTIFIES — the caller publishes after commit (`repositories-never-notify.test.ts`).
 */

export type TimeEntryRefusal =
  | 'not_time_and_materials'
  | 'milestone_not_in_progress'
  | 'milestone_not_found'
  | 'entry_not_found'
  | 'daily_limit_exceeded';

/** A time write refused by a precondition. Nothing is written. */
export class TimeEntryWriteRefusedError extends Error {
  constructor(public readonly reason: TimeEntryRefusal) {
    super(`Time entry write refused: ${reason}`);
    this.name = 'TimeEntryWriteRefusedError';
  }
}

export interface TimeEntryWriteResult {
  entry: EngagementTimeEntry;
  milestone: { id: string; title: string; estimatedMinutes: number | null };
  /** The milestone's live logged total after the write. */
  loggedAfterMinutes: number;
  /** The write crossed the milestone's estimate for the first time at this estimate; audited in the transaction. */
  estimateExceeded: boolean;
  /** Live milestones of the engagement whose logged total is now over their estimate. */
  milestonesOverCount: number;
}

export interface TimeEntryListRow {
  id: string;
  engagementMilestoneId: string;
  userId: string;
  authorFirstName: string | null;
  workedOn: IsoDate;
  minutes: number;
  note: string;
  createdAt: Date;
}

export interface TimeEntrySums {
  totalMinutes: number;
  /** Minutes worked inside the billing period; null when no period was given. */
  periodMinutes: number | null;
  /** Live minutes per milestone id, including milestones since removed. */
  byMilestone: Record<string, number>;
}

export interface OverEstimateAlertRow {
  engagementId: string;
  projectTitle: string | null;
  clientCompanyName: string;
  expertFirstName: string | null;
  expertLastName: string | null;
  agencyName: string | null;
  loggedMinutes: number;
  estimatedMinutes: number;
}

const liveEntry = isNull(engagementTimeEntries.deletedAt);

/** Minutes of live time logged on the engagement, including entries on removed milestones. */
export async function loggedMinutesTx(exec: DbExecutor, engagementId: string): Promise<number> {
  const [row] = await exec
    .select({ total: sum(engagementTimeEntries.minutes) })
    .from(engagementTimeEntries)
    .where(and(eq(engagementTimeEntries.engagementId, engagementId), liveEntry));
  return Number(row?.total ?? 0);
}

async function milestoneLoggedMinutesTx(tx: DbTx, milestoneId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sum(engagementTimeEntries.minutes) })
    .from(engagementTimeEntries)
    .where(and(eq(engagementTimeEntries.engagementMilestoneId, milestoneId), liveEntry));
  return Number(row?.total ?? 0);
}

/** Minutes of live time logged on each of the engagement's milestones that has any. */
export async function loggedMinutesByMilestoneTx(
  exec: DbExecutor,
  engagementId: string
): Promise<Record<string, number>> {
  const rows = await exec
    .select({
      milestoneId: engagementTimeEntries.engagementMilestoneId,
      total: sum(engagementTimeEntries.minutes),
    })
    .from(engagementTimeEntries)
    .where(and(eq(engagementTimeEntries.engagementId, engagementId), liveEntry))
    .groupBy(engagementTimeEntries.engagementMilestoneId);
  return Object.fromEntries(rows.map((r) => [r.milestoneId, Number(r.total ?? 0)]));
}

/** The ids of the engagement's milestones that have live time logged against them. */
export async function milestoneIdsWithLoggedTimeTx(
  exec: DbExecutor,
  engagementId: string
): Promise<Set<string>> {
  return new Set(Object.keys(await loggedMinutesByMilestoneTx(exec, engagementId)));
}

/**
 * Refuse `daily_limit_exceeded` when the author's live minutes on `workedOn`, across the
 * engagement and excluding `excludeEntryId`, plus `minutes` would pass a day.
 */
async function assertWithinDailyLimitTx(
  tx: DbTx,
  input: {
    engagementId: string;
    userId: string;
    workedOn: IsoDate;
    minutes: number;
    excludeEntryId?: string;
  }
): Promise<void> {
  const [row] = await tx
    .select({ total: sum(engagementTimeEntries.minutes) })
    .from(engagementTimeEntries)
    .where(
      and(
        eq(engagementTimeEntries.engagementId, input.engagementId),
        eq(engagementTimeEntries.userId, input.userId),
        eq(engagementTimeEntries.workedOn, input.workedOn),
        liveEntry,
        input.excludeEntryId === undefined
          ? undefined
          : ne(engagementTimeEntries.id, input.excludeEntryId)
      )
    );
  if (Number(row?.total ?? 0) + input.minutes > TIME_ENTRY_MAX_MINUTES) {
    throw new TimeEntryWriteRefusedError('daily_limit_exceeded');
  }
}

/** Live milestones with an estimate whose logged total is over it. */
async function milestonesOverCountTx(tx: DbTx, engagementId: string): Promise<number> {
  const byMilestone = await loggedMinutesByMilestoneTx(tx, engagementId);
  const milestones = await tx
    .select({
      id: engagementMilestones.id,
      estimatedMinutes: engagementMilestones.estimatedMinutes,
    })
    .from(engagementMilestones)
    .where(
      and(
        eq(engagementMilestones.engagementId, engagementId),
        isNull(engagementMilestones.deletedAt),
        isNotNull(engagementMilestones.estimatedMinutes)
      )
    );
  return milestones.filter(
    (m) => m.estimatedMinutes !== null && (byMilestone[m.id] ?? 0) > m.estimatedMinutes
  ).length;
}

async function assertTimeAndMaterialsTx(tx: DbTx, engagementId: string): Promise<void> {
  const { pricingMethod } = await readProjectTermsTx(tx, engagementId);
  if (pricingMethod !== 'tm') throw new TimeEntryWriteRefusedError('not_time_and_materials');
}

function assertInProgress(milestone: EngagementMilestone): void {
  if (milestone.status !== 'in_progress') {
    throw new TimeEntryWriteRefusedError('milestone_not_in_progress');
  }
}

/**
 * Unlocked lock-order discovery: the live milestone's engagement must be `engagementId`.
 * Refuses `milestone_not_found` otherwise, before any lock is taken on another engagement.
 */
async function discoverMilestone(milestoneId: string, engagementId: string): Promise<void> {
  const [row] = await db
    .select({ engagementId: engagementMilestones.engagementId })
    .from(engagementMilestones)
    .where(and(eq(engagementMilestones.id, milestoneId), isNull(engagementMilestones.deletedAt)));
  if (row?.engagementId !== engagementId) {
    throw new TimeEntryWriteRefusedError('milestone_not_found');
  }
}

/**
 * Whose entries a write may reach: `'own'` only the actor's, `'any'` any author's on the
 * engagement. The repository is role-free; the caller decides the scope.
 */
export type TimeEntryAuthorScope = 'own' | 'any';

/**
 * Unlocked lock-order discovery of the milestone a live entry sits on. A missing or removed
 * entry, one on another engagement, one by another author (scope `'own'`), or one whose
 * milestone was removed all refuse with the same `entry_not_found`, so authorship does not leak.
 */
async function discoverEntryMilestoneId(input: {
  engagementId: string;
  entryId: string;
  userId: string;
  authorScope: TimeEntryAuthorScope;
}): Promise<string> {
  const [row] = await db
    .select({ milestoneId: engagementTimeEntries.engagementMilestoneId })
    .from(engagementTimeEntries)
    .innerJoin(
      engagementMilestones,
      and(
        eq(engagementMilestones.id, engagementTimeEntries.engagementMilestoneId),
        isNull(engagementMilestones.deletedAt)
      )
    )
    .where(
      and(
        eq(engagementTimeEntries.id, input.entryId),
        eq(engagementTimeEntries.engagementId, input.engagementId),
        input.authorScope === 'own' ? eq(engagementTimeEntries.userId, input.userId) : undefined,
        liveEntry
      )
    );
  if (row === undefined) throw new TimeEntryWriteRefusedError('entry_not_found');
  return row.milestoneId;
}

/** Re-read the entry FOR UPDATE under the engagement and milestone locks. */
async function lockEntryTx(
  tx: DbTx,
  input: {
    engagementId: string;
    entryId: string;
    userId: string;
    milestoneId: string;
    authorScope: TimeEntryAuthorScope;
  }
): Promise<EngagementTimeEntry> {
  const [entry] = await tx
    .select()
    .from(engagementTimeEntries)
    .where(
      and(
        eq(engagementTimeEntries.id, input.entryId),
        eq(engagementTimeEntries.engagementId, input.engagementId),
        eq(engagementTimeEntries.engagementMilestoneId, input.milestoneId),
        input.authorScope === 'own' ? eq(engagementTimeEntries.userId, input.userId) : undefined,
        liveEntry
      )
    )
    .for('update');
  if (entry === undefined) throw new TimeEntryWriteRefusedError('entry_not_found');
  return entry;
}

/** Whether the over-estimate notice was already recorded for this milestone at this estimate. */
async function crossingRecordedAtTx(
  tx: DbTx,
  milestoneId: string,
  estimatedMinutes: number
): Promise<boolean> {
  const [prior] = await tx
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, 'engagement_milestone'),
        eq(auditEvents.entityId, milestoneId),
        eq(auditEvents.action, 'engagement_milestone.estimate_exceeded'),
        sql`${auditEvents.metadata}->>'estimatedMinutes' = ${String(estimatedMinutes)}`
      )
    )
    .limit(1);
  return prior !== undefined;
}

export interface EstimateExceededMilestone {
  id: string;
  title: string;
  estimatedMinutes: number;
  loggedMinutes: number;
}

/**
 * After an approved change order raises milestone estimates: for each raised milestone whose
 * time logged since the order was sent has already passed its new estimate, record
 * `engagement_milestone.estimate_exceeded` (once per estimate value, as a time write does) and
 * return it so the caller can notify. No later time write crosses that estimate, so the
 * approval is the crossing. Runs inside the approval's transaction, under its engagement lock.
 */
export async function recordEstimatesExceededByChangeTx(
  tx: DbTx,
  input: {
    engagementId: string;
    milestoneIds: readonly string[];
    actorUserId: string;
    changeOrderId: string;
  }
): Promise<{ exceeded: EstimateExceededMilestone[]; milestonesOverCount: number }> {
  const exceeded: EstimateExceededMilestone[] = [];
  for (const milestoneId of input.milestoneIds) {
    const [milestone] = await tx
      .select({
        id: engagementMilestones.id,
        title: engagementMilestones.title,
        estimatedMinutes: engagementMilestones.estimatedMinutes,
      })
      .from(engagementMilestones)
      .where(
        and(
          eq(engagementMilestones.id, milestoneId),
          eq(engagementMilestones.engagementId, input.engagementId),
          isNull(engagementMilestones.deletedAt)
        )
      );
    const est = milestone?.estimatedMinutes ?? null;
    if (milestone === undefined || est === null) continue;
    const logged = await milestoneLoggedMinutesTx(tx, milestone.id);
    if (logged <= est || (await crossingRecordedAtTx(tx, milestone.id, est))) continue;

    await recordDeliveryAudit(tx, {
      actorUserId: input.actorUserId,
      action: 'engagement_milestone.estimate_exceeded',
      entityType: 'engagement_milestone',
      entityId: milestone.id,
      engagementId: input.engagementId,
      metadata: {
        estimatedMinutes: est,
        loggedMinutes: logged,
        changeOrderId: input.changeOrderId,
      },
    });
    exceeded.push({
      id: milestone.id,
      title: milestone.title,
      estimatedMinutes: est,
      loggedMinutes: logged,
    });
  }
  return {
    exceeded,
    milestonesOverCount:
      exceeded.length > 0 ? await milestonesOverCountTx(tx, input.engagementId) : 0,
  };
}

/**
 * Record `engagement_milestone.estimate_exceeded` when the write crosses the estimate and no
 * crossing has been recorded for this milestone at this estimate. Runs under the engagement
 * lock, so the check-then-insert cannot race. Returns whether it recorded one.
 */
async function recordFirstCrossingTx(
  tx: DbTx,
  input: {
    engagementId: string;
    milestone: EngagementMilestone;
    beforeMinutes: number;
    afterMinutes: number;
    timeEntryId: string;
    actorUserId: string;
  }
): Promise<boolean> {
  const est = input.milestone.estimatedMinutes;
  if (est === null || !estimateCrossed(input.beforeMinutes, input.afterMinutes, est)) {
    return false;
  }
  if (await crossingRecordedAtTx(tx, input.milestone.id, est)) return false;

  await recordDeliveryAudit(tx, {
    actorUserId: input.actorUserId,
    action: 'engagement_milestone.estimate_exceeded',
    entityType: 'engagement_milestone',
    entityId: input.milestone.id,
    engagementId: input.engagementId,
    metadata: {
      estimatedMinutes: est,
      loggedMinutes: input.afterMinutes,
      timeEntryId: input.timeEntryId,
    },
  });
  return true;
}

async function writeResultTx(
  tx: DbTx,
  input: {
    engagementId: string;
    entry: EngagementTimeEntry;
    milestone: EngagementMilestone;
    beforeMinutes: number;
    afterMinutes: number;
    actorUserId: string;
  }
): Promise<TimeEntryWriteResult> {
  const estimateExceeded = await recordFirstCrossingTx(tx, {
    engagementId: input.engagementId,
    milestone: input.milestone,
    beforeMinutes: input.beforeMinutes,
    afterMinutes: input.afterMinutes,
    timeEntryId: input.entry.id,
    actorUserId: input.actorUserId,
  });
  return {
    entry: input.entry,
    milestone: {
      id: input.milestone.id,
      title: input.milestone.title,
      estimatedMinutes: input.milestone.estimatedMinutes,
    },
    loggedAfterMinutes: input.afterMinutes,
    estimateExceeded,
    milestonesOverCount: await milestonesOverCountTx(tx, input.engagementId),
  };
}

export const engagementTimeEntriesRepository = {
  /**
   * Log time against an in-progress milestone of an active T&M project. Throws
   * `EngagementNotActiveError` (project not active) or `TimeEntryWriteRefusedError`.
   */
  async log(input: {
    engagementId: string;
    milestoneId: string;
    userId: string;
    minutes: number;
    note: string;
    workedOn: IsoDate;
  }): Promise<TimeEntryWriteResult> {
    await discoverMilestone(input.milestoneId, input.engagementId);
    return db.transaction(async (tx) => {
      const { milestone } = await lockEngagementAndMilestone(tx, input.milestoneId);
      if (milestone.engagementId !== input.engagementId) {
        throw new TimeEntryWriteRefusedError('milestone_not_found');
      }
      await assertTimeAndMaterialsTx(tx, input.engagementId);
      assertInProgress(milestone);
      await assertWithinDailyLimitTx(tx, input);

      const beforeMinutes = await milestoneLoggedMinutesTx(tx, milestone.id);
      const [entry] = await tx
        .insert(engagementTimeEntries)
        .values({
          engagementId: input.engagementId,
          engagementMilestoneId: milestone.id,
          userId: input.userId,
          workedOn: input.workedOn,
          minutes: input.minutes,
          note: input.note,
        })
        .returning();
      if (entry === undefined) throw new Error('Time entry insert returned no row');

      await recordDeliveryAudit(tx, {
        actorUserId: input.userId,
        action: 'engagement_time_entry.logged',
        entityType: 'engagement_time_entry',
        entityId: entry.id,
        engagementId: input.engagementId,
        metadata: {
          milestoneId: milestone.id,
          minutes: entry.minutes,
          workedOn: entry.workedOn,
        },
      });

      return writeResultTx(tx, {
        engagementId: input.engagementId,
        entry,
        milestone,
        beforeMinutes,
        afterMinutes: beforeMinutes + input.minutes,
        actorUserId: input.userId,
      });
    });
  },

  /**
   * Change the minutes and note of an entry on an in-progress milestone, and re-check the
   * estimate crossing. `userId` is the actor (audit); `authorScope` decides whether the entry
   * must be theirs. The daily limit is checked against the entry's author. Throws
   * `EngagementNotActiveError` or `TimeEntryWriteRefusedError`.
   */
  async update(input: {
    engagementId: string;
    entryId: string;
    userId: string;
    authorScope: TimeEntryAuthorScope;
    minutes: number;
    note: string;
  }): Promise<TimeEntryWriteResult> {
    const milestoneId = await discoverEntryMilestoneId(input);
    return db.transaction(async (tx) => {
      const { milestone } = await lockEngagementAndMilestone(tx, milestoneId);
      const current = await lockEntryTx(tx, { ...input, milestoneId });
      await assertTimeAndMaterialsTx(tx, input.engagementId);
      assertInProgress(milestone);
      await assertWithinDailyLimitTx(tx, {
        engagementId: input.engagementId,
        userId: current.userId,
        workedOn: current.workedOn,
        minutes: input.minutes,
        excludeEntryId: current.id,
      });

      const beforeMinutes = await milestoneLoggedMinutesTx(tx, milestone.id);
      const [entry] = await tx
        .update(engagementTimeEntries)
        .set({ minutes: input.minutes, note: input.note, updatedAt: new Date() })
        .where(eq(engagementTimeEntries.id, current.id))
        .returning();
      if (entry === undefined) throw new Error('Time entry update returned no row');

      await recordDeliveryAudit(tx, {
        actorUserId: input.userId,
        action: 'engagement_time_entry.edited',
        entityType: 'engagement_time_entry',
        entityId: entry.id,
        engagementId: input.engagementId,
        metadata: {
          fromMinutes: current.minutes,
          toMinutes: entry.minutes,
          noteChanged: current.note !== entry.note,
        },
      });

      return writeResultTx(tx, {
        engagementId: input.engagementId,
        entry,
        milestone,
        beforeMinutes,
        afterMinutes: beforeMinutes - current.minutes + entry.minutes,
        actorUserId: input.userId,
      });
    });
  },

  /**
   * Soft-delete an entry, on a milestone in any status. No crossing check. `userId` is the
   * actor (audit); `authorScope` decides whether the entry must be theirs. Throws
   * `EngagementNotActiveError` or `TimeEntryWriteRefusedError`.
   */
  async remove(input: {
    engagementId: string;
    entryId: string;
    userId: string;
    authorScope: TimeEntryAuthorScope;
  }): Promise<EngagementTimeEntry> {
    const milestoneId = await discoverEntryMilestoneId(input);
    return db.transaction(async (tx) => {
      await lockEngagementAndMilestone(tx, milestoneId);
      const current = await lockEntryTx(tx, { ...input, milestoneId });
      await assertTimeAndMaterialsTx(tx, input.engagementId);

      const now = new Date();
      const [entry] = await tx
        .update(engagementTimeEntries)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(engagementTimeEntries.id, current.id))
        .returning();
      if (entry === undefined) throw new Error('Time entry delete returned no row');

      await recordDeliveryAudit(tx, {
        actorUserId: input.userId,
        action: 'engagement_time_entry.removed',
        entityType: 'engagement_time_entry',
        entityId: entry.id,
        engagementId: input.engagementId,
        metadata: { minutes: entry.minutes },
      });
      return entry;
    });
  },

  /** The engagement's live entries, newest work date first (ties: newest logged first). */
  async listByEngagement(engagementId: string): Promise<TimeEntryListRow[]> {
    return db
      .select({
        id: engagementTimeEntries.id,
        engagementMilestoneId: engagementTimeEntries.engagementMilestoneId,
        userId: engagementTimeEntries.userId,
        authorFirstName: users.firstName,
        workedOn: engagementTimeEntries.workedOn,
        minutes: engagementTimeEntries.minutes,
        note: engagementTimeEntries.note,
        createdAt: engagementTimeEntries.createdAt,
      })
      .from(engagementTimeEntries)
      .leftJoin(users, eq(users.id, engagementTimeEntries.userId))
      .where(and(eq(engagementTimeEntries.engagementId, engagementId), liveEntry))
      .orderBy(
        desc(engagementTimeEntries.workedOn),
        desc(engagementTimeEntries.createdAt),
        asc(engagementTimeEntries.id)
      );
  },

  /**
   * Live logged minutes: the total, per milestone, and inside the billing period
   * (`startOn` inclusive, `endOn` exclusive). Entries on removed milestones count.
   */
  async sumsForEngagement(
    engagementId: string,
    period: { startOn: IsoDate; endOn: IsoDate } | null
  ): Promise<TimeEntrySums> {
    const byMilestone = await loggedMinutesByMilestoneTx(db, engagementId);
    const totalMinutes = Object.values(byMilestone).reduce((acc, m) => acc + m, 0);
    if (period === null) return { totalMinutes, periodMinutes: null, byMilestone };

    const [row] = await db
      .select({ total: sum(engagementTimeEntries.minutes) })
      .from(engagementTimeEntries)
      .where(
        and(
          eq(engagementTimeEntries.engagementId, engagementId),
          liveEntry,
          gte(engagementTimeEntries.workedOn, period.startOn),
          lt(engagementTimeEntries.workedOn, period.endOn)
        )
      );
    return { totalMinutes, periodMinutes: Number(row?.total ?? 0), byMilestone };
  },

  /**
   * Live milestones of the engagement whose over-estimate notice has already been sent at
   * their current estimate, so going over it again sends nothing. A milestone whose estimate
   * has since changed is not listed: crossing the new estimate notifies again.
   */
  async listNotifiedAtCurrentEstimate(engagementId: string): Promise<string[]> {
    const rows = await db
      .selectDistinct({ id: engagementMilestones.id })
      .from(engagementMilestones)
      .innerJoin(
        auditEvents,
        and(
          eq(auditEvents.entityType, 'engagement_milestone'),
          eq(auditEvents.entityId, engagementMilestones.id),
          eq(auditEvents.action, 'engagement_milestone.estimate_exceeded'),
          sql`${auditEvents.metadata}->>'estimatedMinutes' = ${engagementMilestones.estimatedMinutes}::text`
        )
      )
      .where(
        and(
          eq(engagementMilestones.engagementId, engagementId),
          isNull(engagementMilestones.deletedAt),
          isNotNull(engagementMilestones.estimatedMinutes)
        )
      );
    return rows.map((row) => row.id);
  },

  /**
   * Active T&M projects where the live time logged on live milestones that carry an estimate
   * exceeds the sum of those estimates (at least one required), furthest over first. Time on
   * a milestone without an estimate has nothing to be compared with, so it is left out. The admin
   * `project.over_estimate` finder; a project drops out once an approved change raises the
   * estimate or it leaves `active`.
   */
  async listOverEstimateForAlerts(limit: number): Promise<OverEstimateAlertRow[]> {
    const logged = db
      .select({
        engagementId: engagementTimeEntries.engagementId,
        loggedMinutes: sql<number>`sum(${engagementTimeEntries.minutes})`
          .mapWith(Number)
          .as('logged_total'),
      })
      .from(engagementTimeEntries)
      // Only time on a live milestone with an estimate is compared with the estimate total.
      .innerJoin(
        engagementMilestones,
        and(
          eq(engagementMilestones.id, engagementTimeEntries.engagementMilestoneId),
          isNull(engagementMilestones.deletedAt),
          isNotNull(engagementMilestones.estimatedMinutes)
        )
      )
      .where(liveEntry)
      .groupBy(engagementTimeEntries.engagementId)
      .as('logged');

    const estimated = db
      .select({
        engagementId: engagementMilestones.engagementId,
        estimatedMinutes: sql<number>`sum(${engagementMilestones.estimatedMinutes})`
          .mapWith(Number)
          .as('estimate_total'),
      })
      .from(engagementMilestones)
      .where(
        and(
          isNull(engagementMilestones.deletedAt),
          isNotNull(engagementMilestones.estimatedMinutes)
        )
      )
      .groupBy(engagementMilestones.engagementId)
      .as('estimated');

    return db
      .select({
        engagementId: logged.engagementId,
        projectTitle: projectRequests.title,
        clientCompanyName: companies.name,
        expertFirstName: users.firstName,
        expertLastName: users.lastName,
        agencyName: agencies.name,
        loggedMinutes: logged.loggedMinutes,
        estimatedMinutes: estimated.estimatedMinutes,
      })
      .from(logged)
      .innerJoin(estimated, eq(estimated.engagementId, logged.engagementId))
      .innerJoin(
        engagements,
        and(eq(engagements.id, logged.engagementId), isNull(engagements.deletedAt))
      )
      .innerJoin(
        projectEngagements,
        and(
          eq(projectEngagements.engagementId, engagements.id),
          eq(projectEngagements.pricingMethod, 'tm'),
          eq(projectEngagements.deliveryStatus, 'active'),
          isNull(projectEngagements.deletedAt)
        )
      )
      .innerJoin(companies, eq(companies.id, engagements.companyId))
      .leftJoin(expertProfiles, eq(expertProfiles.id, engagements.expertProfileId))
      .leftJoin(users, and(eq(users.id, expertProfiles.userId), isNull(users.deletedAt)))
      .leftJoin(agencies, eq(agencies.id, expertProfiles.agencyId))
      .leftJoin(
        projectRequests,
        and(
          eq(projectRequests.id, projectEngagements.projectRequestId),
          isNull(projectRequests.deletedAt)
        )
      )
      .where(gt(logged.loggedMinutes, estimated.estimatedMinutes))
      .orderBy(
        desc(sql`${logged.loggedMinutes} - ${estimated.estimatedMinutes}`),
        asc(logged.engagementId)
      )
      .limit(limit);
  },
};
