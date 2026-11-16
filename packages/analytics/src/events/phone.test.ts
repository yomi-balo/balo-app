import { describe, it, expect } from 'vitest';
import { PHONE_EVENTS, CLIENT_SMS_CONSENT_SURFACES, CLIENT_SMS_CONSENT_METHODS } from './phone';

describe('PHONE_EVENTS', () => {
  it('exports PHONE_VERIFIED with the correct event name', () => {
    expect(PHONE_EVENTS.PHONE_VERIFIED).toBe('expert_phone_verified');
  });

  it('exports the client SMS opt-in events with their exact wire values', () => {
    expect(PHONE_EVENTS.CLIENT_SMS_OPT_IN_SHOWN).toBe('client_sms_opt_in_shown');
    expect(PHONE_EVENTS.CLIENT_SMS_OPT_IN_COMPLETED).toBe('client_sms_opt_in_completed');
    expect(PHONE_EVENTS.CLIENT_SMS_OPT_IN_REMOVED).toBe('client_sms_opt_in_removed');
  });

  it('has exactly the expected keys', () => {
    expect(Object.keys(PHONE_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'CLIENT_SMS_OPT_IN_COMPLETED',
      'CLIENT_SMS_OPT_IN_REMOVED',
      'CLIENT_SMS_OPT_IN_SHOWN',
      'PHONE_VERIFIED',
    ]);
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(PHONE_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('client SMS consent vocabularies', () => {
  it('pins the consent surfaces', () => {
    expect([...CLIENT_SMS_CONSENT_SURFACES]).toEqual([
      'booking_confirmation',
      'intro_call_confirmation',
      'account_settings',
    ]);
  });

  it('pins the consent methods', () => {
    expect([...CLIENT_SMS_CONSENT_METHODS]).toEqual(['existing_number', 'new_number']);
  });
});
