/**
 * BAL-331 — Delivery workspace (`/engagements/[id]`) analytics.
 *
 * SERVER-ONLY. `engagement_workspace_viewed` fires once per authorized RSC render
 * of the delivery workspace (after lens resolution, before the tree renders) via
 * `trackServerAndFlush`. BAL-332 adds the three expert milestone-transition events
 * (`engagement_milestone_started/completed/reverted`), fired from the Server Actions
 * after each transition commits. All are SERVER events → they must NOT be added to
 * `AllEvents` (client union) nor to the `apps/web/src/test/setup.ts` client mock.
 *
 * NO PII: only the engagement id, the resolved lens, the entry surface, the
 * engagement status, milestone id, milestone timing metrics, and the `distinct_id`
 * (user UUID) — never a party name/email or the completion-note body.
 */

import type { ScopeChangeRedirectReason } from '@balo/shared/engagements';

export const ENGAGEMENT_SERVER_EVENTS = {
  WORKSPACE_VIEWED: 'engagement_workspace_viewed',
  MILESTONE_STARTED: 'engagement_milestone_started',
  MILESTONE_COMPLETED: 'engagement_milestone_completed',
  MILESTONE_REVERTED: 'engagement_milestone_reverted',
  // BAL-333 (D3) expert delivery-plan scope edits.
  MILESTONE_ADDED: 'engagement_milestone_added',
  MILESTONE_EDITED: 'engagement_milestone_edited',
  MILESTONE_REMOVED: 'engagement_milestone_removed',
  // BAL-334 (D4) expert/admin lifecycle transitions.
  COMPLETION_REQUESTED: 'engagement_completion_requested',
  COMPLETION_WITHDRAWN: 'engagement_completion_withdrawn',
  CANCELLED: 'engagement_cancelled',
  // BAL-338 (D7) client review decision + auto-accept + reminder.
  ACCEPTED: 'engagement_accepted',
  CHANGES_REQUESTED: 'engagement_changes_requested',
  REVIEW_REMINDER_SENT: 'engagement_review_reminder_sent',
  // BAL-622 change orders on a live project (no amounts on any of them).
  CHANGE_ORDER_REQUESTED: 'engagement_change_order_requested',
  CHANGE_ORDER_SENT: 'engagement_change_order_sent',
  CHANGE_ORDER_APPROVED: 'engagement_change_order_approved',
  CHANGE_ORDER_DECLINED: 'engagement_change_order_declined',
  CHANGE_ORDER_WITHDRAWN: 'engagement_change_order_withdrawn',
  // BAL-624 time logged on a time-and-materials project (minutes and hours only, never money).
  TIME_LOGGED: 'engagement_time_logged',
  MILESTONE_ESTIMATE_EXCEEDED: 'engagement_milestone_estimate_exceeded',
} as const;

/**
 * How a `pending_acceptance` engagement reached `completed` — the same discriminated
 * union the D0 repository uses (`acceptCompletion({method})`). `'client'` = an explicit
 * client accept; `'auto'` = the D7 auto-accept sweep after the review window elapsed.
 */
export type EngagementAcceptanceMethod = 'client' | 'auto';

/**
 * BAL-334 (D4) CLIENT-side friction signal — the FIRST client-side engagement event.
 * `engagement_completion_blocked_view` fires ONCE on mount from the expert finish-card
 * island when the "Mark project complete" card renders DISABLED (milestones remain),
 * so we can see how often experts hit the blocked state before finishing. Impression
 * semantics (ref-guarded, once per mount) — server-firing would over-count on every
 * `router.refresh()`. This client constant MUST be added to the
 * `apps/web/src/test/setup.ts` `vi.mock('@/lib/analytics')` export list.
 */
export const ENGAGEMENT_EVENTS = {
  COMPLETION_BLOCKED_VIEW: 'engagement_completion_blocked_view',
  /** A plain milestone write needed the client's approval, so the expert was pointed at a change order. */
  SCOPE_CHANGE_REDIRECTED: 'engagement_scope_change_redirected',
  /** The "More actions" menu opened the cancel-project dialog. */
  CANCEL_DIALOG_OPENED: 'engagement_cancel_dialog_opened',
  /** The cancel-project dialog was closed without cancelling. */
  CANCEL_DIALOG_KEPT: 'engagement_cancel_dialog_kept',
} as const;

export interface EngagementEventMap {
  [ENGAGEMENT_EVENTS.COMPLETION_BLOCKED_VIEW]: {
    engagement_id: string;
    /** Live milestones still to complete before the project can be sent for review. */
    milestones_remaining: number;
  };
  [ENGAGEMENT_EVENTS.SCOPE_CHANGE_REDIRECTED]: {
    engagement_id: string;
    reason: ScopeChangeRedirectReason;
    pricing_method: 'fixed' | 'tm';
    /** `refused` = the write was attempted and declined; `pre_empted` = the UI explained it up front. */
    trigger: 'refused' | 'pre_empted';
  };
  [ENGAGEMENT_EVENTS.CANCEL_DIALOG_OPENED]: {
    engagement_id: string;
    delivery_status: 'active' | 'pending_acceptance';
  };
  [ENGAGEMENT_EVENTS.CANCEL_DIALOG_KEPT]: {
    engagement_id: string;
    delivery_status: 'active' | 'pending_acceptance';
    /** `button` = the Keep button; `dismiss` = Escape or an overlay click. */
    via: 'button' | 'dismiss';
  };
}

/** Viewer lens on the delivery workspace (admin is the observer archetype). */
export type EngagementWorkspaceLens = 'client' | 'expert' | 'admin';

/**
 * How the viewer arrived at the workspace. `request_detail` = the deep-link from
 * the kickoff region of the project-request detail page; `inbox` = a delivery
 * inbox row (D6); `direct` = a bare URL visit / bookmark (default; also the
 * fallback when `?from` is absent or not whitelisted).
 */
export type EngagementWorkspaceEntry = 'request_detail' | 'inbox' | 'direct' | 'agency';

/** Who started a change order: a client request, or the expert proposing one unprompted. */
export type ChangeOrderInitiator = 'client' | 'expert';

/** The properties every change-order event carries. */
interface ChangeOrderEventBase {
  engagement_id: string;
  change_order_id: string;
  pricing_method: string;
  distinct_id: string;
}

/** The properties carried once a change order has lines. */
interface ChangeOrderLinesProps extends ChangeOrderEventBase {
  lines_added: number;
  lines_edited: number;
  lines_removed: number;
  has_price_change: boolean;
  /** `'client'` when `requested_at` is set on the order, otherwise `'expert'`. */
  initiated_by: ChangeOrderInitiator;
}

/** Which expert-side capacity acted: the delivering expert, or an agency owner/admin on their behalf. Carried by every event an agency owner/admin can fire. */
export type ExpertSideActingAs = 'delivering_expert' | 'agency_admin';

/** A change-order event that closes the order, so it records the time taken to decide. */
interface ChangeOrderDecidedProps extends ChangeOrderLinesProps {
  /** Whole days since `sent_at`, int >=0. */
  days_to_decision: number;
}

export interface EngagementServerEventMap {
  [ENGAGEMENT_SERVER_EVENTS.WORKSPACE_VIEWED]: {
    engagement_id: string;
    entry: EngagementWorkspaceEntry;
    /** `Engagement['status']` — active | pending_acceptance | completed | cancelled. */
    engagement_status: string;
    /** User UUID (server-event distinct-id convention). */
    distinct_id: string;
  } & (
    | { lens: Extract<EngagementWorkspaceLens, 'expert'>; acting_as: ExpertSideActingAs }
    | { lens: Exclude<EngagementWorkspaceLens, 'expert'> }
  );
  [ENGAGEMENT_SERVER_EVENTS.MILESTONE_STARTED]: {
    engagement_id: string;
    milestone_id: string;
    /** Whole days from kickoff (`activatedAt ?? createdAt`) to the start, int ≥0. */
    days_since_kickoff: number;
    acting_as: ExpertSideActingAs;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.MILESTONE_COMPLETED]: {
    engagement_id: string;
    milestone_id: string;
    /** Whole days from start to completion, int ≥0 (0 when `startedAt` is null). */
    cycle_time_days: number;
    /** Whether the expert captured a delivery note. */
    has_completion_note: boolean;
    acting_as: ExpertSideActingAs;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.MILESTONE_REVERTED]: {
    engagement_id: string;
    milestone_id: string;
    /** Whole hours from the PRE-revert `completedAt` to now, int ≥0 (0 when absent). */
    hours_since_completed: number;
    acting_as: ExpertSideActingAs;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.MILESTONE_ADDED]: {
    engagement_id: string;
    /** Live milestone count AFTER the add. */
    milestones_total: number;
    acting_as: ExpertSideActingAs;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.MILESTONE_EDITED]: {
    engagement_id: string;
    milestone_id: string;
    /** Descriptive fields changed this edit, e.g. ['title','acceptance_criteria']. */
    fields_changed: string[];
    acting_as: ExpertSideActingAs;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.MILESTONE_REMOVED]: {
    engagement_id: string;
    milestone_id: string;
    was_completed: boolean;
    had_source_provenance: boolean;
    acting_as: ExpertSideActingAs;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.COMPLETION_REQUESTED]: {
    engagement_id: string;
    /** Whole days from kickoff (`activatedAt ?? createdAt`) to the request, int ≥0. */
    days_since_kickoff: number;
    /** The source proposal's `timeframeWeeks`; null for retainers / missing proposals. */
    proposed_timeframe_weeks: number | null;
    /** Live milestone count at request time. */
    milestones_total: number;
    /** Prior `engagement.completion_requested` audit rows incl. this one (1, 2 after a withdraw→re-request). */
    review_cycle: number;
    /** True when at least one change-request round precedes this request. */
    is_resubmission: boolean;
    /** Live change-request rounds before this request (0 on a first submission). */
    prior_change_rounds: number;
    acting_as: ExpertSideActingAs;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.COMPLETION_WITHDRAWN]: {
    engagement_id: string;
    /** Whole hours from the PRE-withdraw `completionRequestedAt` to now, int ≥0 (0 when absent). */
    hours_in_review: number;
    acting_as: ExpertSideActingAs;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.CANCELLED]: {
    engagement_id: string;
    /** The engagement status at cancel time (only `active`/`pending_acceptance` are cancellable). */
    status_at_cancel: 'active' | 'pending_acceptance';
    /** Whole days from kickoff (`activatedAt ?? createdAt`) to cancel, int ≥0. */
    days_since_kickoff: number;
    /** Completed live milestones at cancel time. */
    milestones_completed: number;
    /** Total live milestones at cancel time. */
    milestones_total: number;
    distinct_id: string;
  };
  // BAL-338 (D7): does the client actually review, how often does auto fire, why do
  // reviews bounce? `acceptance_method` splits explicit-client vs auto-accept; on the
  // auto path there is no acting user, so `distinct_id` is a stable system id.
  [ENGAGEMENT_SERVER_EVENTS.ACCEPTED]: {
    engagement_id: string;
    /** `'client'` (explicit accept) | `'auto'` (sweep after the review window). */
    acceptance_method: EngagementAcceptanceMethod;
    /** Whole days from `completionRequestedAt` to acceptance, int ≥0. */
    days_in_review: number;
    /** nth completion request for this engagement (1, 2 after a change-request→re-request). */
    review_cycle: number;
    /** Acceptor UUID on `'client'`; a stable system id (e.g. `system:auto-accept`) on `'auto'`. */
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.CHANGES_REQUESTED]: {
    engagement_id: string;
    /** Whole days from `completionRequestedAt` to the change request, int ≥0. */
    days_in_review: number;
    /** nth completion request for this engagement (the review cycle being bounced). */
    review_cycle: number;
    /** Ordinal of this change-request round (live rounds, this one included), int ≥1. */
    round_number: number;
    /** Milestones the client tagged on this round; 0 for an untagged round. */
    tagged_milestone_count: number;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.REVIEW_REMINDER_SENT]: {
    engagement_id: string;
    /** The reminder recipient (client-company owner) UUID. */
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_REQUESTED]: ChangeOrderEventBase & {
    initiated_by: 'client';
  };
  [ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_SENT]: ChangeOrderLinesProps & {
    acting_as: ExpertSideActingAs;
  };
  [ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_APPROVED]: ChangeOrderDecidedProps;
  [ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_DECLINED]: ChangeOrderDecidedProps &
    (
      | {
          /** The expert answered a request without proposing a change order. */
          answered_without_change_order: true;
          acting_as: ExpertSideActingAs;
        }
      | { answered_without_change_order: false }
    );
  [ENGAGEMENT_SERVER_EVENTS.CHANGE_ORDER_WITHDRAWN]: ChangeOrderDecidedProps & {
    acting_as: ExpertSideActingAs;
  };
  [ENGAGEMENT_SERVER_EVENTS.TIME_LOGGED]: {
    engagement_id: string;
    milestone_id: string;
    minutes: number;
    /** True when this entry took the milestone past its estimate for the first time. */
    crossed_estimate: boolean;
    /** Logged time as a whole percentage of the estimate; null when the estimate is null or 0. */
    milestone_pct_of_estimate: number | null;
    acting_as: ExpertSideActingAs;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.MILESTONE_ESTIMATE_EXCEEDED]: {
    engagement_id: string;
    milestone_id: string;
    /** Live milestones now over their estimate, this one included. */
    milestones_over_count: number;
    /** Absent on the client change-order-approval path. */
    acting_as?: ExpertSideActingAs;
    distinct_id: string;
  };
}
