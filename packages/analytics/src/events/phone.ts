export const PHONE_EVENTS = {
  PHONE_VERIFIED: 'expert_phone_verified',
  CLIENT_SMS_OPT_IN_SHOWN: 'client_sms_opt_in_shown',
  CLIENT_SMS_OPT_IN_COMPLETED: 'client_sms_opt_in_completed',
  CLIENT_SMS_OPT_IN_REMOVED: 'client_sms_opt_in_removed',
} as const;

/** Every surface that can record a client SMS consent change. */
export const CLIENT_SMS_CONSENT_SURFACES = [
  'booking_confirmation',
  'intro_call_confirmation',
  'account_settings',
] as const;

/** How a client SMS consent was given: on an already-verified number, or after verifying a new one. */
export const CLIENT_SMS_CONSENT_METHODS = ['existing_number', 'new_number'] as const;

export type ClientSmsConsentEventSurface = (typeof CLIENT_SMS_CONSENT_SURFACES)[number];

/** Booking surfaces that offer the client SMS opt-in card. */
export type ClientSmsOptInSurface = Exclude<ClientSmsConsentEventSurface, 'account_settings'>;

export type ClientSmsConsentMethod = (typeof CLIENT_SMS_CONSENT_METHODS)[number];

export interface PhoneEventMap {
  [PHONE_EVENTS.PHONE_VERIFIED]: {
    /** E.164 phone number masked to last 4 digits before sending. */
    phone_masked: string;
    /** ISO country code derived from the phone number, e.g. 'AU'. */
    country_code: string;
    /** Which surface triggered the verification: onboarding wizard or expert settings. */
    source: 'onboarding' | 'settings';
  };
  [PHONE_EVENTS.CLIENT_SMS_OPT_IN_SHOWN]: {
    /** Where the opt-in card rendered its offer. */
    surface: ClientSmsOptInSurface;
    /** True when the offer is a one-click consent on an already-verified number. */
    has_verified_phone: boolean;
  };
  [PHONE_EVENTS.CLIENT_SMS_OPT_IN_COMPLETED]: {
    surface: ClientSmsConsentEventSurface;
    /** `existing_number` consented on a verified number; `new_number` verified one first. */
    method: ClientSmsConsentMethod;
  };
  [PHONE_EVENTS.CLIENT_SMS_OPT_IN_REMOVED]: {
    surface: 'account_settings';
  };
}
