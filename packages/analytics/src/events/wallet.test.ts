import { describe, it, expect } from 'vitest';
import { WALLET_EVENTS } from './wallet';

describe('WALLET_EVENTS (client)', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(WALLET_EVENTS)).toEqual(['WIDGET_VIEWED', 'NUDGE_CLICKED', 'TOPUP_CLICKED']);
  });

  it('maps each constant to its snake_case event name', () => {
    expect(WALLET_EVENTS.WIDGET_VIEWED).toBe('wallet_widget_viewed');
    expect(WALLET_EVENTS.NUDGE_CLICKED).toBe('wallet_nudge_clicked');
    expect(WALLET_EVENTS.TOPUP_CLICKED).toBe('wallet_topup_clicked');
  });

  it('values follow the snake_case naming convention', () => {
    for (const value of Object.values(WALLET_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('every value is feature-prefixed with `wallet_`', () => {
    for (const value of Object.values(WALLET_EVENTS)) {
      expect(value).toMatch(/^wallet_/);
    }
  });
});
