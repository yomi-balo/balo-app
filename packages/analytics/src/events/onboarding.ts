export const ONBOARDING_EVENTS = {
  STEP_VIEWED: 'onboarding_step_viewed',
  STEP_COMPLETED: 'onboarding_step_completed',
  COMPLETED: 'onboarding_completed',
} as const;

export type OnboardingStepName = 'name' | 'welcome' | 'timezone' | 'intent';

export interface OnboardingEventMap {
  [ONBOARDING_EVENTS.STEP_VIEWED]: {
    step: OnboardingStepName;
    step_number: number;
  };
  [ONBOARDING_EVENTS.STEP_COMPLETED]: {
    step: OnboardingStepName;
    step_number: number;
    value?: string;
  };
  [ONBOARDING_EVENTS.COMPLETED]: {
    intent: 'client' | 'expert';
    timezone: string;
  };
}
