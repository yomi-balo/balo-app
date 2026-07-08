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
} as const;

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
}
