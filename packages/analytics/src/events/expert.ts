export const EXPERT_EVENTS = {
  APPLICATION_STARTED: 'expert_application_started',
  APPLICATION_RESUMED: 'expert_application_resumed',
  APPLICATION_STEP_COMPLETED: 'expert_application_step_completed',
  APPLICATION_STEP_SKIPPED: 'expert_application_step_skipped',
  APPLICATION_SUBMITTED: 'expert_application_submitted',
  APPLICATION_SUBMIT_FAILED: 'expert_application_submit_failed',
  APPLICATION_ABANDONED: 'expert_application_abandoned',
  // BAL-325 — referral prompt on the /expert/apply/success page.
  REFERRAL_PROMPT_VIEWED: 'expert_referral_prompt_viewed', // denominator (prompt shown)
  REFERRAL_INVITES_SENT: 'expert_referral_invites_sent', // numerator (invites dispatched)
  // BAL-337 — fired when Done is clicked on a product with no rating yet.
  ASSESSMENT_DONE_BLOCKED: 'expert_application_assessment_done_blocked',
} as const;

export type ExpertStepName =
  | 'profile'
  | 'products'
  | 'assessment'
  | 'certifications'
  | 'work-history'
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
  };
  [EXPERT_EVENTS.APPLICATION_SUBMIT_FAILED]: {
    error_message: string;
  };
  [EXPERT_EVENTS.APPLICATION_ABANDONED]: {
    last_step: ExpertStepName;
    step_number: number;
  };
  [EXPERT_EVENTS.REFERRAL_PROMPT_VIEWED]: Record<string, never>;
  [EXPERT_EVENTS.REFERRAL_INVITES_SENT]: {
    invites_sent: number; // invites newly dispatched this submission
    invites_attempted: number; // total addresses entered
    already_invited: number; // addresses already invited (no-op)
  };
  [EXPERT_EVENTS.ASSESSMENT_DONE_BLOCKED]: {
    product_id: string;
  };
}

// -- Server events (fire from server actions via trackServerAndFlush) ------------------
export const EXPERT_SERVER_EVENTS = {
  DRAFT_SAVED: 'expert_application_draft_saved',
  DRAFT_SAVE_FAILED: 'expert_application_draft_save_failed',
} as const;

export interface ExpertServerEventMap {
  [EXPERT_SERVER_EVENTS.DRAFT_SAVED]: {
    step: ExpertStepName;
    expert_profile_id: string;
    distinct_id: string;
  };
  [EXPERT_SERVER_EVENTS.DRAFT_SAVE_FAILED]: {
    step: ExpertStepName;
    error_code: 'validation' | 'duplicate_key' | 'unknown';
    expert_profile_id: string | null;
    distinct_id: string;
  };
}
