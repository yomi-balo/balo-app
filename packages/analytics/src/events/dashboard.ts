import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';
import type { Workspace } from '@balo/shared/workspaces';

/**
 * BAL-566 — the dashboard "Up next" card's client event family (D16). Read-only surface: no
 * server events, no `identify()`/`reset()` calls.
 */
export const DASHBOARD_EVENTS = {
  UP_NEXT_VIEWED: 'dashboard_up_next_viewed',
  UP_NEXT_CLICKED: 'dashboard_up_next_clicked',
} as const;

/**
 * The context types Up next lists, in display-tile order. The web view model derives its type
 * from this (`NAV_ITEM_KEYS` precedent), so the event vocabulary and the listed set cannot drift.
 */
export const DASHBOARD_UP_NEXT_MEETING_TYPES = [
  'case',
  'project_kickoff',
  'project_discovery',
  'request_interaction',
] as const satisfies readonly MeetingContextTypeWithHolder[];
export type DashboardUpNextMeetingType = (typeof DASHBOARD_UP_NEXT_MEETING_TYPES)[number];

export const DASHBOARD_UP_NEXT_TARGETS = [
  'row',
  'join',
  'cases',
  'projects',
  'calendar',
  'find_expert',
] as const;
export type DashboardUpNextTarget = (typeof DASHBOARD_UP_NEXT_TARGETS)[number];

export const DASHBOARD_UP_NEXT_ROW_STATES = ['upcoming', 'starting_soon', 'happening_now'] as const;
export type DashboardUpNextRowState = (typeof DASHBOARD_UP_NEXT_ROW_STATES)[number];

export interface DashboardEventMap {
  [DASHBOARD_EVENTS.UP_NEXT_VIEWED]: {
    workspace_type: Workspace['type']; // 'company' | 'expert' (D11)
    /** Rows delivered by the server. `0` means the Empty state rendered. */
    row_count: number;
    /** Distinct context types present, in `DASHBOARD_UP_NEXT_MEETING_TYPES` tuple order. */
    meeting_types: DashboardUpNextMeetingType[];
  };
  [DASHBOARD_EVENTS.UP_NEXT_CLICKED]: {
    target: DashboardUpNextTarget;
    /** `null` for footer links and the Empty-state "Find an expert" CTA. */
    meeting_type: DashboardUpNextMeetingType | null;
    /** `null` for footer links and the Empty-state "Find an expert" CTA. */
    row_state: DashboardUpNextRowState | null;
  };
}
