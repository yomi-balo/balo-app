import { describe, it, expect } from 'vitest';
import { PROMO_SERVER_EVENTS } from './promo';

describe('PROMO_SERVER_EVENTS (BAL-384)', () => {
  it('has exactly the promo-code-created server event', () => {
    expect(Object.keys(PROMO_SERVER_EVENTS)).toEqual(['PROMO_CODE_CREATED']);
  });

  it('maps the constant to its exact event name', () => {
    expect(PROMO_SERVER_EVENTS.PROMO_CODE_CREATED).toBe('promo_code_created');
  });

  it('uses the {feature}_{noun}_{past_tense_verb} snake_case convention', () => {
    for (const value of Object.values(PROMO_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
