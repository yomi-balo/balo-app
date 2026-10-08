import { describe, it, expect } from 'vitest';
import { EXPERT_LANGUAGES_MAX, EXPERT_INDUSTRIES_MAX } from './expert-profile-limits';

/**
 * Pins the language/industry caps, so a change to either constant is a deliberate one.
 */
describe('expert profile limits', () => {
  it('caps languages at 10', () => {
    expect(EXPERT_LANGUAGES_MAX).toBe(10);
  });

  it('caps industries at 20', () => {
    expect(EXPERT_INDUSTRIES_MAX).toBe(20);
  });
});
