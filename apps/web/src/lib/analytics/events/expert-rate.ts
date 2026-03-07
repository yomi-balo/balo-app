export const EXPERT_RATE_EVENTS = {
  RATE_SAVED: 'expert_rate_saved',
} as const;

export interface ExpertRateEventMap {
  [EXPERT_RATE_EVENTS.RATE_SAVED]: {
    rate_per_minute_cents: number;
    is_initial_setup: boolean;
  };
}
