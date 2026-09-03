import { describe, it, expect } from 'vitest';
import { SETTINGS_EVENTS, SETTINGS_SECTIONS } from './settings';

describe('SETTINGS_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(SETTINGS_EVENTS)).toEqual([
      'SECTION_VIEWED',
      'BILLING_TOPUP_CLICKED',
      'BILLING_REDEEM_CLICKED',
      'BILLING_LOW_BALANCE_SAVED',
      'BILLING_MANDATE_ARMED',
      'BILLING_CARD_SAVED',
      'BILLING_CARD_REMOVED',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(SETTINGS_EVENTS.SECTION_VIEWED).toBe('settings_section_viewed');
    expect(SETTINGS_EVENTS.BILLING_TOPUP_CLICKED).toBe('settings_billing_topup_clicked');
    expect(SETTINGS_EVENTS.BILLING_REDEEM_CLICKED).toBe('settings_billing_redeem_clicked');
    expect(SETTINGS_EVENTS.BILLING_LOW_BALANCE_SAVED).toBe('settings_billing_low_balance_saved');
    expect(SETTINGS_EVENTS.BILLING_MANDATE_ARMED).toBe('settings_billing_mandate_armed');
    expect(SETTINGS_EVENTS.BILLING_CARD_SAVED).toBe('settings_billing_card_saved');
    expect(SETTINGS_EVENTS.BILLING_CARD_REMOVED).toBe('settings_billing_card_removed');
  });

  it('values follow the naming convention {feature}_{noun}_{past_tense_verb}', () => {
    for (const value of Object.values(SETTINGS_EVENTS)) {
      expect(value).toMatch(/^settings_[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('SETTINGS_SECTIONS', () => {
  it('is the exact pinned tuple, in order', () => {
    expect(SETTINGS_SECTIONS).toEqual(['company', 'team', 'billing', 'notifications']);
  });

  it('has 4 entries with no duplicates', () => {
    expect(SETTINGS_SECTIONS.length).toBe(4);
    expect(new Set(SETTINGS_SECTIONS).size).toBe(4);
  });
});
