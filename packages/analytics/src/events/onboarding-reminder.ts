// BAL-374 onboarding-completion reminder funnel. Snake_case values, feature-prefixed.
// `_sent` is SERVER-emitted by the API sweep at each reminder publish; `_clicked` is
// CLIENT-emitted from the `/onboarding` landing when a user arrives via the reminder
// CTA. `_scheduled` is architecturally N/A under a repeatable sweep (there is no
// scheduling act — the sweep discovers eligibility), and `_converted` is a deferred
// follow-up (it needs persisted per-user reminder state to attribute a completion to a
// step) — neither is defined here.
export const ONBOARDING_REMINDER_SERVER_EVENTS = {
  /** The sweep published a reminder for a cadence step to an un-onboarded user. */
  SENT: 'onboarding_reminder_sent',
} as const;

export const ONBOARDING_REMINDER_EVENTS = {
  /** The user landed on `/onboarding` via a reminder CTA (once per mount, ref-guarded). */
  CLICKED: 'onboarding_reminder_clicked',
} as const;

/** 2-way domain class dimension (string-compatible with `@balo/shared` DomainClass). */
export type OnboardingReminderDomainClass = 'corporate' | 'freemail';

export interface OnboardingReminderServerEventMap {
  [ONBOARDING_REMINDER_SERVER_EVENTS.SENT]: {
    cadence_step: 1 | 2 | 3;
    domain_class: OnboardingReminderDomainClass;
    /** The un-onboarded user's UUID (the reminder subject). */
    distinct_id: string;
  };
}

export interface OnboardingReminderEventMap {
  [ONBOARDING_REMINDER_EVENTS.CLICKED]: {
    cadence_step: 1 | 2 | 3;
    domain_class: OnboardingReminderDomainClass;
  };
}
