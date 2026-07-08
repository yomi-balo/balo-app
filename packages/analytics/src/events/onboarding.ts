import type { AuthMethodSignal } from './auth';

export const ONBOARDING_EVENTS = {
  STEP_VIEWED: 'onboarding_step_viewed',
  STEP_COMPLETED: 'onboarding_step_completed',
  COMPLETED: 'onboarding_completed',
} as const;

export type OnboardingStepName = 'name' | 'welcome' | 'timezone' | 'intent' | 'company';

export interface OnboardingEventMap {
  [ONBOARDING_EVENTS.STEP_VIEWED]: {
    step: OnboardingStepName;
    step_number: number;
    // BAL-350: coarse auth-method signal for the company step (optional —
    // existing callers and pre-existing sessions omit it).
    auth_method?: AuthMethodSignal;
    // BAL-350: true when the company resolve RPC threw and the step fell open to
    // the create branch. Optional; only the company step ever sets it.
    resolve_failed_open?: boolean;
  };
  [ONBOARDING_EVENTS.STEP_COMPLETED]: {
    step: OnboardingStepName;
    step_number: number;
    value?: string;
    // BAL-350: see STEP_VIEWED above.
    auth_method?: AuthMethodSignal;
    resolve_failed_open?: boolean;
  };
  [ONBOARDING_EVENTS.COMPLETED]: {
    intent: 'client' | 'expert';
    timezone: string;
  };
}
