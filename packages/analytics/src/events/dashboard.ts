import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';
import type { Workspace } from '@balo/shared/workspaces';

/**
 * BAL-566 — the dashboard "Up next" card's client event family (D16). Read-only surface: no
 * server events, no `identify()`/`reset()` calls.
 */
export const DASHBOARD_EVENTS = {
  UP_NEXT_VIEWED: 'dashboard_up_next_viewed',
  UP_NEXT_CLICKED: 'dashboard_up_next_clicked',
  YOUR_MOVE_VIEWED: 'dashboard_your_move_viewed',
  YOUR_MOVE_CLICKED: 'dashboard_your_move_clicked',
  YOUR_MOVE_FILTERED: 'dashboard_your_move_filtered',
  TRACK_CLICKED: 'dashboard_track_clicked',
  TRACK_TERM_OPENED: 'dashboard_track_term_opened',
} as const;

export const DASHBOARD_YOUR_MOVE_CARD_KINDS = [
  'calendar_reconnect',
  'invitation',
  'eoi_followup',
  'proposal_requested',
  'changes_requested',
  'delivery_changes',
  'action_items',
  'messages',
  'receivable',
  'reschedule',
  'completion',
  'kickoff_billing',
  'kickoff_payment',
  'exploratory_call',
  'eoi_reply',
  'proposal_review',
  'join_requests',
] as const;
export type DashboardYourMoveCardKind = (typeof DASHBOARD_YOUR_MOVE_CARD_KINDS)[number];

export const DASHBOARD_YOUR_MOVE_CHIPS = [
  'all',
  'calendar',
  'invitations',
  'interest',
  'proposals',
  'kickoff',
  'delivery',
  'action_items',
  'messages',
  'billing',
  'new_times',
  'work_to_review',
  'calls',
  'replies',
  'team',
] as const;
export type DashboardYourMoveChip = (typeof DASHBOARD_YOUR_MOVE_CHIPS)[number];

export const DASHBOARD_YOUR_MOVE_TARGETS = ['card', 'action'] as const;
export type DashboardYourMoveTarget = (typeof DASHBOARD_YOUR_MOVE_TARGETS)[number];

/**
 * The context types Up next lists, in display-tile order. The web view model derives its type
 * from this (`NAV_ITEM_KEYS` precedent), so the event vocabulary and the listed set cannot drift.
 * `project_call` (BAL-616) sits beside `project_kickoff`: both are calls on a project engagement,
 * and a call carried over at kickoff must stay on the dashboard.
 */
export const DASHBOARD_UP_NEXT_MEETING_TYPES = [
  'case',
  'project_kickoff',
  'project_call',
  'project_discovery',
  'request_interaction',
] as const satisfies readonly MeetingContextTypeWithHolder[];
export type DashboardUpNextMeetingType = (typeof DASHBOARD_UP_NEXT_MEETING_TYPES)[number];

export const DASHBOARD_TRACK_STAGES = [
  'invited',
  'eoi',
  'matching',
  'interest',
  'proposal',
  'kickoff',
  'delivery',
] as const;
export type DashboardTrackStage = (typeof DASHBOARD_TRACK_STAGES)[number];

export const DASHBOARD_TRACK_TURNS = ['your_move', 'in_progress', 'waiting'] as const;
export type DashboardTrackTurn = (typeof DASHBOARD_TRACK_TURNS)[number];

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

/**
 * BAL-616 — which surface sent an `UP_NEXT_CLICKED`. `dashboard` is the Up next card;
 * `request_thread` is the request page conversation header's Join, which reuses this event so
 * every Join click is counted in one place.
 */
export const DASHBOARD_UP_NEXT_SURFACES = ['dashboard', 'request_thread'] as const;
export type DashboardUpNextSurface = (typeof DASHBOARD_UP_NEXT_SURFACES)[number];

export interface DashboardEventMap {
  [DASHBOARD_EVENTS.UP_NEXT_VIEWED]: {
    workspace_type: Workspace['type']; // 'company' | 'expert' (D11)
    /** Rows delivered by the server. `0` means the Empty state rendered. */
    row_count: number;
    /** Distinct context types present, in `DASHBOARD_UP_NEXT_MEETING_TYPES` tuple order. */
    meeting_types: DashboardUpNextMeetingType[];
  };
  [DASHBOARD_EVENTS.UP_NEXT_CLICKED]: {
    /** BAL-616 — the Up next card sends `dashboard`; the request page header `request_thread`. */
    surface: DashboardUpNextSurface;
    target: DashboardUpNextTarget;
    /** `null` for footer links and the Empty-state "Find an expert" CTA. */
    meeting_type: DashboardUpNextMeetingType | null;
    /** `null` for footer links and the Empty-state "Find an expert" CTA. */
    row_state: DashboardUpNextRowState | null;
  };
  [DASHBOARD_EVENTS.YOUR_MOVE_VIEWED]: {
    workspace_type: Workspace['type'];
    card_count: number;
    /** Distinct card kinds present, in `DASHBOARD_YOUR_MOVE_CARD_KINDS` tuple order. */
    card_kinds: DashboardYourMoveCardKind[];
  };
  [DASHBOARD_EVENTS.YOUR_MOVE_CLICKED]: {
    workspace_type: Workspace['type'];
    target: DashboardYourMoveTarget;
    card_kind: DashboardYourMoveCardKind;
    /** 1-based position in the visible (filtered) list. */
    position: number;
  };
  [DASHBOARD_EVENTS.YOUR_MOVE_FILTERED]: {
    workspace_type: Workspace['type'];
    chip: DashboardYourMoveChip;
    /** Cards remaining after the filter is applied. */
    card_count: number;
  };
  [DASHBOARD_EVENTS.TRACK_CLICKED]: {
    workspace_type: Workspace['type'];
    stage: DashboardTrackStage;
    turn: DashboardTrackTurn;
  };
  [DASHBOARD_EVENTS.TRACK_TERM_OPENED]: {
    workspace_type: Workspace['type'];
    target: 'stage' | 'legend';
    /** The stage for a `stage` target, the turn for a `legend` target. */
    key: DashboardTrackStage | DashboardTrackTurn;
    /** How it opened: mouse hover or click/keyboard on desktop, a tap on mobile. */
    via: 'hover' | 'click' | 'tap';
  };
}
