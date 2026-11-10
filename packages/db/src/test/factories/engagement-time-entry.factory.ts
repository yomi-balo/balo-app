import { db } from '../../client';
import { engagementTimeEntries } from '../../schema';
import type { EngagementTimeEntry, NewEngagementTimeEntry } from '../../schema';
import { engagementMilestoneFactory } from './engagement-milestone.factory';
import { userFactory } from './user.factory';

interface EngagementTimeEntryFactoryOverrides {
  /** Reuse an existing milestone (and its engagement). Defaults to a fresh in-progress one on a T&M project. */
  milestone?: { id: string; engagementId: string };
  /** The author. Defaults to a fresh user. */
  userId?: string;
  /** Row-level overrides (minutes, note, workedOn, deletedAt, …). */
  values?: Partial<NewEngagementTimeEntry>;
}

export interface EngagementTimeEntryFactoryResult {
  entry: EngagementTimeEntry;
  engagementId: string;
  milestoneId: string;
  userId: string;
}

/**
 * Seeds one `engagement_time_entries` row (default one hour, worked today in UTC). Inserts
 * directly via `db`, not the repository, so tests can seed entries on any milestone or
 * project — including removed entries — without the write preconditions.
 */
export async function engagementTimeEntryFactory(
  overrides: EngagementTimeEntryFactoryOverrides = {}
): Promise<EngagementTimeEntryFactoryResult> {
  const milestone =
    overrides.milestone ??
    (await engagementMilestoneFactory({ values: { status: 'in_progress', estimatedMinutes: 480 } }))
      .milestone;
  const userId = overrides.userId ?? (await userFactory()).id;

  const [entry] = await db
    .insert(engagementTimeEntries)
    .values({
      engagementId: milestone.engagementId,
      engagementMilestoneId: milestone.id,
      userId,
      workedOn: new Date().toISOString().slice(0, 10),
      minutes: 60,
      note: 'Mapped the opportunity fields.',
      ...overrides.values,
    })
    .returning();
  if (entry === undefined) {
    throw new Error('engagement time entry insert failed');
  }

  return { entry, engagementId: milestone.engagementId, milestoneId: milestone.id, userId };
}
