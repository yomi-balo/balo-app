import { db } from '../../client';
import { engagementMilestones } from '../../schema';
import type { EngagementMilestone, NewEngagementMilestone } from '../../schema';
import { engagementFactory } from './engagement.factory';
import { userFactory } from './user.factory';

interface EngagementMilestoneFactoryOverrides {
  /** Reuse an existing engagement instead of seeding a fresh active one. */
  engagementId?: string;
  /** Snapshot author. Defaults to a fresh user. */
  createdByUserId?: string;
  /** Row-level overrides (status, sortOrder, valueCents, deletedAt, …). */
  values?: Partial<NewEngagementMilestone>;
}

export interface EngagementMilestoneFactoryResult {
  milestone: EngagementMilestone;
  engagementId: string;
  createdByUserId: string;
}

/**
 * Seeds one `engagement_milestones` row (default `status='pending'`,
 * `sort_order=0`) under an active engagement. Inserts directly via `db` (not the
 * repository transitions) so tests can seed ANY status/sort_order combination —
 * including completed/soft-deleted rows — without driving the guarded lifecycle.
 * Overrides flow through `.values(...)`.
 */
export async function engagementMilestoneFactory(
  overrides: EngagementMilestoneFactoryOverrides = {}
): Promise<EngagementMilestoneFactoryResult> {
  const engagementId = overrides.engagementId ?? (await engagementFactory()).engagement.id;
  const createdByUserId = overrides.createdByUserId ?? (await userFactory()).id;

  const [milestone] = await db
    .insert(engagementMilestones)
    .values({
      engagementId,
      sortOrder: 0,
      title: 'Discovery & design',
      status: 'pending',
      createdByUserId,
      ...overrides.values,
    })
    .returning();
  if (milestone === undefined) {
    throw new Error('engagement milestone insert failed');
  }

  return { milestone, engagementId, createdByUserId };
}
