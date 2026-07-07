/**
 * BAL-331 — Delivery workspace (`/engagements/[id]`) analytics.
 *
 * SERVER-ONLY. `engagement_workspace_viewed` fires once per authorized RSC render
 * of the delivery workspace (after lens resolution, before the tree renders) via
 * `trackServerAndFlush`. It is NOT a browser event → it must NOT be added to
 * `AllEvents` (client union) nor to the `apps/web/src/test/setup.ts` client mock.
 *
 * NO PII: only the engagement id, the resolved lens, the entry surface, the
 * engagement status, and the `distinct_id` (user UUID) — never a party name/email.
 */
export const ENGAGEMENT_SERVER_EVENTS = {
  WORKSPACE_VIEWED: 'engagement_workspace_viewed',
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
}
