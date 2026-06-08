export const PROJECT_EVENTS = {
  PROJECT_DRAWER_OPENED: 'project_drawer_opened',
  PROJECT_ENTRY_SELECTED: 'project_entry_selected',
  PROJECT_STEP_VIEWED: 'project_step_viewed',
  PROJECT_REQUEST_SUBMITTED: 'project_request_submitted',
} as const;

export type ProjectEntryMethod = 'manual' | 'ai';
export type ProjectStep = 'start' | 'manual' | 'review' | 'done';

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
}
