import { describe, it, expect } from 'vitest';
import {
  ENGAGEMENT_EVENTS,
  ENGAGEMENT_SERVER_EVENTS,
  type EngagementServerEventMap,
} from './engagement';

describe('ENGAGEMENT_SERVER_EVENTS', () => {
  it('exposes workspace-viewed + the BAL-332 transition + BAL-333 scope-edit + BAL-334 lifecycle + BAL-338 review server events', () => {
    expect(Object.keys(ENGAGEMENT_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'ACCEPTED',
      'CANCELLED',
      'CHANGE_ORDER_APPROVED',
      'CHANGE_ORDER_DECLINED',
      'CHANGE_ORDER_REQUESTED',
      'CHANGE_ORDER_SENT',
      'CHANGE_ORDER_WITHDRAWN',
      'CHANGES_REQUESTED',
      'COMPLETION_REQUESTED',
      'COMPLETION_WITHDRAWN',
      'MILESTONE_ADDED',
      'MILESTONE_COMPLETED',
      'MILESTONE_EDITED',
      'MILESTONE_ESTIMATE_EXCEEDED',
      'MILESTONE_REMOVED',
      'MILESTONE_REVERTED',
      'MILESTONE_STARTED',
      'REVIEW_REMINDER_SENT',
      'TIME_LOGGED',
      'WORKSPACE_VIEWED',
    ]);
  });

  it('maps each change-order constant to its exact snake_case event name', () => {
    expect(ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_REQUESTED).toBe(
      'engagement_change_order_requested'
    );
    expect(ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_SENT).toBe('engagement_change_order_sent');
    expect(ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_APPROVED).toBe('engagement_change_order_approved');
    expect(ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_DECLINED).toBe('engagement_change_order_declined');
    expect(ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_WITHDRAWN).toBe(
      'engagement_change_order_withdrawn'
    );
  });

  it('maps each milestone constant to its exact snake_case event name', () => {
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_STARTED).toBe('engagement_milestone_started');
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_COMPLETED).toBe('engagement_milestone_completed');
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_REVERTED).toBe('engagement_milestone_reverted');
    // BAL-333 scope-edit events.
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_ADDED).toBe('engagement_milestone_added');
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_EDITED).toBe('engagement_milestone_edited');
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_REMOVED).toBe('engagement_milestone_removed');
    // BAL-334 lifecycle events.
    expect(ENGAGEMENT_SERVER_EVENTS.COMPLETION_REQUESTED).toBe('engagement_completion_requested');
    expect(ENGAGEMENT_SERVER_EVENTS.COMPLETION_WITHDRAWN).toBe('engagement_completion_withdrawn');
    expect(ENGAGEMENT_SERVER_EVENTS.CANCELLED).toBe('engagement_cancelled');
    // BAL-338 (D7) client review + auto-accept + reminder events.
    expect(ENGAGEMENT_SERVER_EVENTS.ACCEPTED).toBe('engagement_accepted');
    expect(ENGAGEMENT_SERVER_EVENTS.CHANGES_REQUESTED).toBe('engagement_changes_requested');
    expect(ENGAGEMENT_SERVER_EVENTS.REVIEW_REMINDER_SENT).toBe('engagement_review_reminder_sent');
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(ENGAGEMENT_SERVER_EVENTS)) {
      expect(value).toMatch(/^engagement_[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('ENGAGEMENT_SERVER_EVENTS — time entries (BAL-624)', () => {
  it('maps the time-entry constants to their exact event names', () => {
    expect(ENGAGEMENT_SERVER_EVENTS.TIME_LOGGED).toBe('engagement_time_logged');
    expect(ENGAGEMENT_SERVER_EVENTS.MILESTONE_ESTIMATE_EXCEEDED).toBe(
      'engagement_milestone_estimate_exceeded'
    );
  });
});

describe('ENGAGEMENT_EVENTS', () => {
  it('exposes exactly the client-side engagement events', () => {
    expect(Object.keys(ENGAGEMENT_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'CANCEL_DIALOG_KEPT',
      'CANCEL_DIALOG_OPENED',
      'COMPLETION_BLOCKED_VIEW',
      'SCOPE_CHANGE_REDIRECTED',
    ]);
  });

  it('maps the scope-change redirect to its exact snake_case event name', () => {
    expect(ENGAGEMENT_EVENTS.SCOPE_CHANGE_REDIRECTED).toBe('engagement_scope_change_redirected');
  });

  it('maps the cancel-dialog constants to their exact event names', () => {
    expect(ENGAGEMENT_EVENTS.CANCEL_DIALOG_OPENED).toBe('engagement_cancel_dialog_opened');
    expect(ENGAGEMENT_EVENTS.CANCEL_DIALOG_KEPT).toBe('engagement_cancel_dialog_kept');
  });
});

describe('change-order acting_as typing', () => {
  it('requires acting_as on expert-side sends, withdrawals and no-change-order answers', () => {
    const base = {
      engagement_id: 'e',
      change_order_id: 'c',
      pricing_method: 'fixed',
      distinct_id: 'u',
      lines_added: 0,
      lines_edited: 0,
      lines_removed: 0,
      has_price_change: false,
      initiated_by: 'expert' as const,
    };
    const decided = { ...base, days_to_decision: 0 };
    const sent: EngagementServerEventMap['engagement_change_order_sent'] = {
      ...base,
      acting_as: 'agency_admin',
    };
    const withdrawn: EngagementServerEventMap['engagement_change_order_withdrawn'] = {
      ...decided,
      acting_as: 'delivering_expert',
    };
    const clientDecline: EngagementServerEventMap['engagement_change_order_declined'] = {
      ...decided,
      answered_without_change_order: false,
    };
    // @ts-expect-error acting_as is required when the expert answers without a change order
    const missing: EngagementServerEventMap['engagement_change_order_declined'] = {
      ...decided,
      answered_without_change_order: true,
    };
    expect([sent, withdrawn, clientDecline, missing]).toHaveLength(4);
  });
});
