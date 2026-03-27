export const PHONE_EVENTS = {
  PHONE_VERIFIED: 'expert_phone_verified',
} as const;

export interface PhoneEventMap {
  [PHONE_EVENTS.PHONE_VERIFIED]: {
    /** E.164 phone number masked to last 4 digits before sending. */
    phone_masked: string;
    /** ISO country code derived from the phone number, e.g. 'AU'. */
    country_code: string;
    /** Which surface triggered the verification: onboarding wizard or expert settings. */
    source: 'onboarding' | 'settings';
  };
}
