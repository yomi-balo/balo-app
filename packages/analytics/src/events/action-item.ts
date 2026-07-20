/**
 * BAL-391 (ADR-1043) — action items (a first-class, engagement-owned meeting
 * primitive) analytics.
 *
 * SERVER-ONLY. All six events fire from the delivery-workspace Server Actions via
 * `trackServerAndFlush` (like the BAL-332 engagement milestone events) after each
 * mutation commits. They must NOT be added to `AllEvents` (the client union) nor to
 * the `apps/web/src/test/setup.ts` client mock — that mock is client-only.
 *
 * NO PII: only the engagement id, the action-item id, the source, the assignee/actor
 * ROLE (a side, never a person), field-name lists, and the `distinct_id` (user UUID,
 * or a stable system id on the ai_extracted path) — never a party name/email or the
 * item body.
 */
export const ACTION_ITEM_SERVER_EVENTS = {
  CREATED: 'action_item_created',
  ASSIGNED: 'action_item_assigned',
  COMPLETED: 'action_item_completed',
  REOPENED: 'action_item_reopened',
  EDITED: 'action_item_edited',
  REMOVED: 'action_item_removed',
} as const;

/** Which SIDE an item is assigned to for analytics; `unassigned` = null column value. */
export type ActionItemAssigneeRole = 'client' | 'expert' | 'unassigned';

/** The actor's lens on the engagement (admin = the platform observer, actor label 'Balo'). */
export type ActionItemActorRole = 'client' | 'expert' | 'admin';

export interface ActionItemServerEventMap {
  [ACTION_ITEM_SERVER_EVENTS.CREATED]: {
    engagement_id: string;
    source: 'ai_extracted' | 'manual';
    assignee_role: ActionItemAssigneeRole;
    /** 1 for a manual add; N for an ai_extracted batch (fired by the BAL-387 producer). */
    count: number;
    /** User UUID; a stable system id (e.g. 'system:action-item-pipeline') on the ai path. */
    distinct_id: string;
  };
  [ACTION_ITEM_SERVER_EVENTS.ASSIGNED]: {
    engagement_id: string;
    action_item_id: string;
    assignee_role: ActionItemAssigneeRole;
    distinct_id: string;
  };
  [ACTION_ITEM_SERVER_EVENTS.COMPLETED]: {
    engagement_id: string;
    action_item_id: string;
    completed_by_role: ActionItemActorRole;
    was_ai_extracted: boolean;
    distinct_id: string;
  };
  [ACTION_ITEM_SERVER_EVENTS.REOPENED]: {
    engagement_id: string;
    action_item_id: string;
    distinct_id: string;
  };
  [ACTION_ITEM_SERVER_EVENTS.EDITED]: {
    engagement_id: string;
    action_item_id: string;
    /** The changed field names this edit, e.g. ['body','due_at']. */
    fields_changed: string[];
    distinct_id: string;
  };
  [ACTION_ITEM_SERVER_EVENTS.REMOVED]: {
    engagement_id: string;
    action_item_id: string;
    distinct_id: string;
  };
}
