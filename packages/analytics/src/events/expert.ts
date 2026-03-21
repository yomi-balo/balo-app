export const EXPERT_EVENTS = {
  APPLICATION_STARTED: 'expert_application_started',
  APPLICATION_RESUMED: 'expert_application_resumed',
  APPLICATION_STEP_COMPLETED: 'expert_application_step_completed',
  APPLICATION_STEP_SKIPPED: 'expert_application_step_skipped',
  APPLICATION_SUBMITTED: 'expert_application_submitted',
  APPLICATION_SUBMIT_FAILED: 'expert_application_submit_failed',
  APPLICATION_ABANDONED: 'expert_application_abandoned',
} as const;

export type ExpertStepName =
  | 'profile'
  | 'products'
  | 'assessment'
  | 'certifications'
  | 'work-history'
  | 'invite'
  | 'terms';

export interface ExpertEventMap {
  [EXPERT_EVENTS.APPLICATION_STARTED]: Record<string, never>;
  [EXPERT_EVENTS.APPLICATION_RESUMED]: {
    resumed_at_step: ExpertStepName;
  };
  [EXPERT_EVENTS.APPLICATION_STEP_COMPLETED]: {
    step: ExpertStepName;
    step_number: number;
  };
  [EXPERT_EVENTS.APPLICATION_STEP_SKIPPED]: {
    step: ExpertStepName;
    step_number: number;
  };
  [EXPERT_EVENTS.APPLICATION_SUBMITTED]: {
    products_count: number;
    certs_count: number;
    work_history_count: number;
    referrals_count: number;
  };
  [EXPERT_EVENTS.APPLICATION_SUBMIT_FAILED]: {
    error_message: string;
  };
  [EXPERT_EVENTS.APPLICATION_ABANDONED]: {
    last_step: ExpertStepName;
    step_number: number;
  };
}
