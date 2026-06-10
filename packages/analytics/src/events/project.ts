export const PROJECT_EVENTS = {
  PROJECT_DRAWER_OPENED: 'project_drawer_opened',
  PROJECT_ENTRY_SELECTED: 'project_entry_selected',
  PROJECT_STEP_VIEWED: 'project_step_viewed',
  // Legacy ProjectDrawer UI event (manual path), keyed off expert_id — NOT the
  // persisted request_id — and predating the origination spine. SUPERSEDED by
  // PROJECT_REQUEST_CREATED: do NOT sum the two in one metric and add no new fire
  // sites. A1 consolidates — when it wires PROJECT_REQUEST_CREATED it should drop
  // the single PROJECT_REQUEST_SUBMITTED fire (project-drawer.tsx) so one submit
  // never emits both (else the creation funnel ~2x double-counts).
  PROJECT_REQUEST_SUBMITTED: 'project_request_submitted',
  // Request origination contract (BAL-267 / BAL-266) — DEFINED here; FIRED by the
  // A1–A7 UI slices. PROJECT_REQUEST_CREATED is the CANONICAL "a project_requests
  // row was persisted" event and the single source of truth for the creation
  // funnel: fire it exactly once per created row, at the persisted-row boundary
  // (right after createProjectRequest resolves), keyed off request_id, for EVERY
  // source (manual | ai | quickstart). The rest key off persisted row ids too.
  PROJECT_REQUEST_CREATED: 'project_request_created',
  PROJECT_REQUEST_STATUS_TRANSITIONED: 'project_request_status_transitioned',
  PROJECT_EXPERT_INVITED: 'project_expert_invited',
  PROJECT_EOI_SUBMITTED: 'project_eoi_submitted',
  PROJECT_EOI_WITHDRAWN: 'project_eoi_withdrawn',
  PROJECT_PROPOSAL_REQUESTED: 'project_proposal_requested',
  PROJECT_PROPOSAL_SUBMITTED: 'project_proposal_submitted',
  PROJECT_PROPOSAL_ACCEPTED: 'project_proposal_accepted',
  PROJECT_KICKOFF_APPROVED: 'project_kickoff_approved',
  // Request-detail page (A1 / BAL-268) viewer-occurrence signals, fired from the
  // client analytics island. DETAIL_VIEWED on mount; PHASE_FLIPPED the first time
  // a viewer sees this request in Phase 2 (per request+lens, sessionStorage-guarded
  // — the true server transition is PROJECT_REQUEST_STATUS_TRANSITIONED); DETAIL_DWELL
  // on tab-hide / unload.
  PROJECT_REQUEST_DETAIL_VIEWED: 'project_request_detail_viewed',
  PROJECT_REQUEST_PHASE_FLIPPED: 'project_request_phase_flipped',
  PROJECT_REQUEST_DETAIL_DWELL: 'project_request_detail_dwell',
} as const;

export type ProjectEntryMethod = 'manual' | 'ai';
export type ProjectStep = 'start' | 'manual' | 'review' | 'done';
export type ProjectActor = 'client' | 'expert' | 'admin';
/** Viewer lens on the request-detail page (admin is the observer archetype). */
export type ProjectRequestLens = 'client' | 'expert' | 'admin';
export type ProjectRequestArchetype = 'participant' | 'observer';
export type ProjectRequestPhase = 'phase1' | 'phase2';

export interface ProjectEventMap {
  [PROJECT_EVENTS.PROJECT_DRAWER_OPENED]: { expert_id: string };
  [PROJECT_EVENTS.PROJECT_ENTRY_SELECTED]: { expert_id: string; method: ProjectEntryMethod };
  [PROJECT_EVENTS.PROJECT_STEP_VIEWED]: { expert_id: string; step: ProjectStep };
  [PROJECT_EVENTS.PROJECT_REQUEST_SUBMITTED]: {
    expert_id: string;
    send_to: 'direct' | 'match';
    tag_count: number;
    product_count: number;
    document_count: number;
    method: ProjectEntryMethod;
  };
  [PROJECT_EVENTS.PROJECT_REQUEST_CREATED]: {
    request_id: string;
    send_to: 'direct' | 'match';
    source: 'manual' | 'ai' | 'quickstart';
  };
  [PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED]: {
    request_id: string;
    from: string;
    to: string;
    actor: ProjectActor;
    /**
     * ms from request creation → the FIRST admin action (status was `requested`).
     * Computed server-side in the action and attached client-side. Absent on
     * later transitions. Powers the "raised → first admin action" metric.
     */
    time_to_first_admin_action_ms?: number;
  };
  [PROJECT_EVENTS.PROJECT_EXPERT_INVITED]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
    actor: 'admin';
  };
  [PROJECT_EVENTS.PROJECT_EOI_SUBMITTED]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
    /**
     * ms from the relationship invite (`invitedAt`) → the EOI submit/resubmit.
     * Computed server-side in the action and attached client-side. Powers the
     * "invite → EOI" timing metric. Optional (absent if `invitedAt` is unavailable).
     */
    time_to_eoi_ms?: number;
  };
  [PROJECT_EVENTS.PROJECT_EOI_WITHDRAWN]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
  };
  [PROJECT_EVENTS.PROJECT_PROPOSAL_REQUESTED]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
    actor: 'client' | 'admin';
  };
  [PROJECT_EVENTS.PROJECT_PROPOSAL_SUBMITTED]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
    price_cents: number;
    currency: string;
  };
  [PROJECT_EVENTS.PROJECT_PROPOSAL_ACCEPTED]: {
    request_id: string;
    relationship_id: string;
    expert_id: string;
    proposal_id: string;
  };
  [PROJECT_EVENTS.PROJECT_KICKOFF_APPROVED]: {
    request_id: string;
    actor: 'admin';
  };
  [PROJECT_EVENTS.PROJECT_REQUEST_DETAIL_VIEWED]: {
    request_id: string;
    lens: ProjectRequestLens;
    archetype: ProjectRequestArchetype;
    status: string;
    phase: ProjectRequestPhase;
  };
  [PROJECT_EVENTS.PROJECT_REQUEST_PHASE_FLIPPED]: {
    request_id: string;
    lens: ProjectRequestLens;
    from_phase: 'phase1';
    to_phase: 'phase2';
  };
  [PROJECT_EVENTS.PROJECT_REQUEST_DETAIL_DWELL]: {
    request_id: string;
    lens: ProjectRequestLens;
    status: string;
    dwell_ms: number;
  };
}
