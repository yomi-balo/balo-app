export const PROJECTS_INBOX_EVENTS = {
  INBOX_VIEWED: 'projects_inbox_viewed',
  INBOX_FILTER_APPLIED: 'projects_inbox_filter_applied',
  INBOX_LENS_SWITCHED: 'projects_inbox_lens_switched',
  INBOX_HERO_CTA_CLICKED: 'projects_inbox_hero_cta_clicked',
  INBOX_LIST_ROW_CLICKED: 'projects_inbox_list_row_clicked',
} as const;

/** Which lens the portfolio dashboard is showing. */
export type ProjectsInboxLens = 'client' | 'expert' | 'admin';

/** The stat-tile filter applied to the participant list. */
export type ProjectsInboxFilter = 'all' | 'needs' | 'in_progress' | 'kicked';

/**
 * A7 tri-lens portfolio dashboard events (BAL-274). All client-side via
 * `track()`. PM derives stage distribution from `inbox_viewed` counts + per-row
 * events (no dedicated event). `time_to_first_action_ms` is seeded in
 * `sessionStorage` on `inbox_viewed` and read+cleared on the first hero-CTA or
 * list-row click.
 */
export interface ProjectsInboxEventMap {
  [PROJECTS_INBOX_EVENTS.INBOX_VIEWED]: {
    lens: ProjectsInboxLens;
    needs_count: number;
    in_progress_count: number;
    total_count: number;
  };
  [PROJECTS_INBOX_EVENTS.INBOX_FILTER_APPLIED]: {
    lens: ProjectsInboxLens;
    filter: ProjectsInboxFilter;
    result_count: number;
  };
  [PROJECTS_INBOX_EVENTS.INBOX_LENS_SWITCHED]: {
    from_lens: ProjectsInboxLens;
    to_lens: ProjectsInboxLens;
  };
  [PROJECTS_INBOX_EVENTS.INBOX_HERO_CTA_CLICKED]: {
    lens: ProjectsInboxLens;
    /** `project_requests.id`, or null for engagement rows (whose id is an engagement id). */
    request_id: string | null;
    stage: string;
    nudge: string;
    time_to_first_action_ms: number | null;
  };
  [PROJECTS_INBOX_EVENTS.INBOX_LIST_ROW_CLICKED]: {
    lens: ProjectsInboxLens;
    /** `project_requests.id`, or null for engagement rows (whose id is an engagement id). */
    request_id: string | null;
    stage: string;
    needs_you: boolean;
    from_filter: ProjectsInboxFilter;
  };
}
