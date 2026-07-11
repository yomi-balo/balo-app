import type { AuthMethodSignal } from './auth';

export const ONBOARDING_EVENTS = {
  STEP_VIEWED: 'onboarding_step_viewed',
  STEP_COMPLETED: 'onboarding_step_completed',
  COMPLETED: 'onboarding_completed',
  // BAL-361: the wizard was reached (any arrival). `forced` is true when the
  // fail-closed middleware gate redirected an un-onboarded user here.
  LANDING_REACHED: 'onboarding_landing_reached',
  // BAL-361: fired in addition to LANDING_REACHED when arrival carries `?forced=1`.
  FORCED_ON_LOGIN: 'onboarding_forced_on_login',
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
  // BAL-361: emitted once on wizard mount. `from` is the origin pathname the gate
  // redirected from (analytics only; never used for navigation).
  [ONBOARDING_EVENTS.LANDING_REACHED]: {
    forced: boolean;
    from?: string;
  };
  [ONBOARDING_EVENTS.FORCED_ON_LOGIN]: {
    from?: string;
  };
}
