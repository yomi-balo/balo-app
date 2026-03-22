// -- Client events (fire from browser) -----------------------------------------------
export const EXPERT_PAYOUT_EVENTS = {
  PAYOUT_DETAILS_SAVED: 'expert_payout_details_saved',
  PAYOUT_DETAILS_UPDATED: 'expert_payout_details_updated',
  PAYOUT_COUNTRY_SELECTED: 'expert_payout_country_selected',
  PAYOUT_FORM_STARTED: 'expert_payout_form_started',
} as const;

export interface ExpertPayoutEventMap {
  [EXPERT_PAYOUT_EVENTS.PAYOUT_DETAILS_SAVED]: {
    country_code: string;
    transfer_method: string;
    is_initial_setup: boolean;
  };
  [EXPERT_PAYOUT_EVENTS.PAYOUT_DETAILS_UPDATED]: {
    country_code: string;
    transfer_method: string;
  };
  [EXPERT_PAYOUT_EVENTS.PAYOUT_COUNTRY_SELECTED]: {
    country_code: string;
  };
  [EXPERT_PAYOUT_EVENTS.PAYOUT_FORM_STARTED]: {
    country_code: string;
  };
}

// -- Server events (fire from API/workers via trackServer) ----------------------------
export const EXPERT_PAYOUT_SERVER_EVENTS = {
  AIRWALLEX_BENEFICIARY_REGISTERED: 'expert_airwallex_beneficiary_registered',
  AIRWALLEX_BENEFICIARY_FAILED: 'expert_airwallex_beneficiary_failed',
} as const;

export interface ExpertPayoutServerEventMap {
  [EXPERT_PAYOUT_SERVER_EVENTS.AIRWALLEX_BENEFICIARY_REGISTERED]: {
    method: string;
    country_code: string;
    beneficiary_status: 'verified';
    distinct_id: string;
  };
  [EXPERT_PAYOUT_SERVER_EVENTS.AIRWALLEX_BENEFICIARY_FAILED]: {
    method: string;
    country_code: string;
    error_type: 'validation' | 'outage';
    beneficiary_status: 'invalid' | 'pending_verification';
    distinct_id: string;
  };
}
