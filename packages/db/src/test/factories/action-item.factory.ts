import { db } from '../../client';
import { actionItems } from '../../schema';
import type { ActionItem, NewActionItem } from '../../schema';
import { engagementFactory } from './engagement.factory';
import { userFactory } from './user.factory';

interface ActionItemFactoryOverrides {
  /** Reuse an existing engagement instead of seeding a fresh active one. */
  engagementId?: string;
  /** Item author. Defaults to a fresh user. */
  createdByUserId?: string;
  /** Row-level overrides (status, source, assigneeParty, dueAt, deletedAt, …). */
  values?: Partial<NewActionItem>;
}

export interface ActionItemFactoryResult {
  actionItem: ActionItem;
  engagementId: string;
  createdByUserId: string;
}

/**
 * Seeds one `action_items` row (default `source='manual'`, `status='open'`,
 * `body='Follow up on the migration plan'`) under an active engagement. Inserts
 * directly via `db` (not the guarded repository methods) so tests can seed ANY
 * status/source/assignee/deleted combination — including done/soft-deleted rows —
 * without driving the guarded lifecycle. Overrides flow through `.values(...)`.
 */
export async function actionItemFactory(
  overrides: ActionItemFactoryOverrides = {}
): Promise<ActionItemFactoryResult> {
  const engagementId = overrides.engagementId ?? (await engagementFactory()).engagement.id;
  const createdByUserId = overrides.createdByUserId ?? (await userFactory()).id;

  const [actionItem] = await db
    .insert(actionItems)
    .values({
      engagementId,
      body: 'Follow up on the migration plan',
      source: 'manual',
      status: 'open',
      createdByUserId,
      ...overrides.values,
    })
    .returning();
  if (actionItem === undefined) {
    throw new Error('action item insert failed');
  }

  return { actionItem, engagementId, createdByUserId };
}
