export const EXPERT_SETUP_EVENTS = {
  SETUP_STEP_COMPLETED: 'expert_setup_step_completed',
  SETUP_ALL_COMPLETE: 'expert_setup_all_complete',
} as const;

export interface ExpertSetupEventMap {
  [EXPERT_SETUP_EVENTS.SETUP_STEP_COMPLETED]: {
    step: string;
    step_number: number;
    completed_count: number;
    total: 5;
  };
  [EXPERT_SETUP_EVENTS.SETUP_ALL_COMPLETE]: Record<string, never>;
}
