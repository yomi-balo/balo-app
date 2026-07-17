import { describe, it, expect } from 'vitest';
import { CREDIT_EVENTS, CREDIT_SERVER_EVENTS } from './credit';

describe('CREDIT_EVENTS (client)', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(CREDIT_EVENTS)).toEqual([
      'PURCHASE_STARTED',
      'PURCHASE_COMPLETED',
      'PROMO_REDEEMED',
      'MANDATE_CAPTURED',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(CREDIT_EVENTS.PURCHASE_STARTED).toBe('credit_purchase_started');
    expect(CREDIT_EVENTS.PURCHASE_COMPLETED).toBe('credit_purchase_completed');
    expect(CREDIT_EVENTS.PROMO_REDEEMED).toBe('promo_redeemed');
    expect(CREDIT_EVENTS.MANDATE_CAPTURED).toBe('mandate_captured');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(CREDIT_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('CREDIT_SERVER_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(CREDIT_SERVER_EVENTS)).toEqual([
      'DORMANCY_REMINDER_SENT',
      'BALANCE_EXPIRED',
      'FX_CACHE_STALE',
    ]);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(CREDIT_SERVER_EVENTS.DORMANCY_REMINDER_SENT).toBe('credit_dormancy_reminder_sent');
    expect(CREDIT_SERVER_EVENTS.BALANCE_EXPIRED).toBe('credit_balance_expired');
    expect(CREDIT_SERVER_EVENTS.FX_CACHE_STALE).toBe('credit_fx_cache_stale');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(CREDIT_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('every value is feature-prefixed with `credit_`', () => {
    for (const value of Object.values(CREDIT_SERVER_EVENTS)) {
      expect(value).toMatch(/^credit_/);
    }
  });
});
