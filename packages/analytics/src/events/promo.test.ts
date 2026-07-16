import { describe, it, expect } from 'vitest';
import { PROMO_SERVER_EVENTS, PROMO_EVENTS } from './promo';

describe('PROMO_SERVER_EVENTS (BAL-384 + BAL-383)', () => {
  it('has exactly the three server events (mint + redeem + redeem-vs-cap)', () => {
    expect(Object.keys(PROMO_SERVER_EVENTS)).toEqual([
      'PROMO_CODE_CREATED',
      'PROMO_REDEEMED',
      'PROMO_CODE_REDEEMED_VS_CAP',
    ]);
  });

  it('maps each server constant to its exact event name', () => {
    expect(PROMO_SERVER_EVENTS.PROMO_CODE_CREATED).toBe('promo_code_created');
    expect(PROMO_SERVER_EVENTS.PROMO_REDEEMED).toBe('promo_redeemed');
    expect(PROMO_SERVER_EVENTS.PROMO_CODE_REDEEMED_VS_CAP).toBe('promo_code_redeemed_vs_cap');
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(PROMO_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('PROMO_EVENTS (BAL-383 client events)', () => {
  it('has exactly the two client events (balance-exhausted + continue-card-captured)', () => {
    expect(Object.keys(PROMO_EVENTS)).toEqual([
      'PROMO_BALANCE_EXHAUSTED',
      'PROMO_CONTINUE_CARD_CAPTURED',
    ]);
  });

  it('maps each client constant to its exact event name', () => {
    expect(PROMO_EVENTS.PROMO_BALANCE_EXHAUSTED).toBe('promo_balance_exhausted');
    expect(PROMO_EVENTS.PROMO_CONTINUE_CARD_CAPTURED).toBe('promo_continue_card_captured');
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(PROMO_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
