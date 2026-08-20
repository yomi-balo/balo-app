import type { ExpertChecklistItemKey, ExpertSearchabilityTrigger } from '@balo/shared/experts';

export const EXPERT_SETUP_EVENTS = {
  SETUP_STEP_COMPLETED: 'expert_setup_step_completed',
  SETUP_ALL_COMPLETE: 'expert_setup_all_complete',
} as const;

export interface ExpertSetupEventMap {
  [EXPERT_SETUP_EVENTS.SETUP_STEP_COMPLETED]: {
    step: string;
    step_number: number;
    completed_count: number;
    total: 6;
  };
  [EXPERT_SETUP_EVENTS.SETUP_ALL_COMPLETE]: Record<string, never>;
}

/**
 * BAL-414 (D7) — `expert_profiles.searchable` now derives from the six-item checklist in BOTH
 * directions, from BOTH a server context (the API credential-break/repair triggers) and the
 * web dashboard read path (an `import 'server-only'` RSC function — `track()` is unusable
 * there). SERVER-ONLY by construction: no client event, no `AllEvents` entry.
 *
 * `failing_items` is required-and-empty rather than optional-when-searchable, so the payload
 * shape stays constant — that is what the exact-key-set guard in `expert-setup.test.ts` checks.
 */
export const EXPERT_SETUP_SERVER_EVENTS = {
  SEARCHABILITY_CHANGED: 'expert_searchability_changed',
} as const;

export interface ExpertSetupServerEventMap {
  [EXPERT_SETUP_SERVER_EVENTS.SEARCHABILITY_CHANGED]: {
    expert_id: string;
    searchable: boolean;
    trigger: ExpertSearchabilityTrigger;
    failing_items: ExpertChecklistItemKey[];
    previous_state: boolean;
    distinct_id: string;
  };
}
