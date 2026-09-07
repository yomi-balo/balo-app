import { describe, it, expect } from 'vitest';
import {
  STRIPE_REDIRECT_EVENTS,
  STRIPE_REDIRECT_SURFACES,
  STRIPE_REDIRECT_UNBOUND_REASONS,
} from './stripe-redirect';

describe('STRIPE_REDIRECT_EVENTS (client)', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(STRIPE_REDIRECT_EVENTS)).toEqual(['RETURN_UNBOUND']);
  });

  it('maps RETURN_UNBOUND to its snake_case event name', () => {
    expect(STRIPE_REDIRECT_EVENTS.RETURN_UNBOUND).toBe('stripe_redirect_return_unbound');
  });
});

describe('STRIPE_REDIRECT_SURFACES', () => {
  it('lists exactly settings and redeem, in order', () => {
    expect(STRIPE_REDIRECT_SURFACES).toEqual(['settings', 'redeem']);
  });
});

describe('STRIPE_REDIRECT_UNBOUND_REASONS', () => {
  it('lists exactly the three reasons, in order', () => {
    expect(STRIPE_REDIRECT_UNBOUND_REASONS).toEqual([
      'no_binding',
      'id_mismatch',
      'duplicate_params',
    ]);
  });
});
