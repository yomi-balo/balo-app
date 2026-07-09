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
} as const;

export interface EngagementEventMap {
  [ENGAGEMENT_EVENTS.COMPLETION_BLOCKED_VIEW]: {
    engagement_id: string;
    /** Live milestones still to complete before the project can be sent for review. */
    milestones_remaining: number;
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
export type EngagementWorkspaceEntry = 'request_detail' | 'inbox' | 'direct';

export interface EngagementServerEventMap {
  [ENGAGEMENT_SERVER_EVENTS.WORKSPACE_VIEWED]: {
    engagement_id: string;
    lens: EngagementWorkspaceLens;
    entry: EngagementWorkspaceEntry;
    /** `Engagement['status']` — active | pending_acceptance | completed | cancelled. */
    engagement_status: string;
    /** User UUID (server-event distinct-id convention). */
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.MILESTONE_STARTED]: {
    engagement_id: string;
    milestone_id: string;
    /** Whole days from kickoff (`activatedAt ?? createdAt`) to the start, int ≥0. */
    days_since_kickoff: number;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.MILESTONE_COMPLETED]: {
    engagement_id: string;
    milestone_id: string;
    /** Whole days from start to completion, int ≥0 (0 when `startedAt` is null). */
    cycle_time_days: number;
    /** Whether the expert captured a delivery note. */
    has_completion_note: boolean;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.MILESTONE_REVERTED]: {
    engagement_id: string;
    milestone_id: string;
    /** Whole hours from the PRE-revert `completedAt` to now, int ≥0 (0 when absent). */
    hours_since_completed: number;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.MILESTONE_ADDED]: {
    engagement_id: string;
    /** Live milestone count AFTER the add. */
    milestones_total: number;
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.MILESTONE_EDITED]: {
    engagement_id: string;
    milestone_id: string;
    /** Descriptive fields changed this edit, e.g. ['title','acceptance_criteria']. */
    fields_changed: string[];
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.MILESTONE_REMOVED]: {
    engagement_id: string;
    milestone_id: string;
    was_completed: boolean;
    had_source_provenance: boolean;
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
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.COMPLETION_WITHDRAWN]: {
    engagement_id: string;
    /** Whole hours from the PRE-withdraw `completionRequestedAt` to now, int ≥0 (0 when absent). */
    hours_in_review: number;
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
    distinct_id: string;
  };
  [ENGAGEMENT_SERVER_EVENTS.REVIEW_REMINDER_SENT]: {
    engagement_id: string;
    /** The reminder recipient (client-company owner) UUID. */
    distinct_id: string;
  };
}
