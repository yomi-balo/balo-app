export const PROJECT_EVENTS = {
  PROJECT_DRAWER_OPENED: 'project_drawer_opened',
  PROJECT_ENTRY_SELECTED: 'project_entry_selected',
  PROJECT_STEP_VIEWED: 'project_step_viewed',
  PROJECT_REQUEST_SUBMITTED: 'project_request_submitted',
  // Request origination contract (BAL-267 / BAL-266) — DEFINED here; FIRED by
  // the A1–A7 UI slices. Keyed off persisted row ids once the request exists.
  PROJECT_REQUEST_CREATED: 'project_request_created',
  PROJECT_REQUEST_STATUS_TRANSITIONED: 'project_request_status_transitioned',
  PROJECT_EXPERT_INVITED: 'project_expert_invited',
  PROJECT_EOI_SUBMITTED: 'project_eoi_submitted',
  PROJECT_PROPOSAL_REQUESTED: 'project_proposal_requested',
  PROJECT_PROPOSAL_SUBMITTED: 'project_proposal_submitted',
  PROJECT_PROPOSAL_ACCEPTED: 'project_proposal_accepted',
  PROJECT_KICKOFF_APPROVED: 'project_kickoff_approved',
} as const;

export type ProjectEntryMethod = 'manual' | 'ai';
export type ProjectStep = 'start' | 'manual' | 'review' | 'done';
export type ProjectActor = 'client' | 'expert' | 'admin';

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
}
