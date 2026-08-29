import { describe, it, expect } from 'vitest';
import {
  buildOnboardingUrl,
  hasPendingApplyIntent,
  PENDING_APPLY_PATH,
} from './onboarding-return-to';

describe('buildOnboardingUrl', () => {
  it('appends the encoded returnTo when signing up from /expert/apply', () => {
    expect(buildOnboardingUrl('/expert/apply')).toBe('/onboarding?returnTo=%2Fexpert%2Fapply');
  });

  it('returns the plain path for every other origin (ordinary signup, unaffected)', () => {
    expect(buildOnboardingUrl('/')).toBe('/onboarding');
    expect(buildOnboardingUrl('/experts')).toBe('/onboarding');
    expect(buildOnboardingUrl('/experts/jane-doe')).toBe('/onboarding');
    expect(buildOnboardingUrl('/expert/apply/success')).toBe('/onboarding');
  });
});

describe('hasPendingApplyIntent', () => {
  it('is true only for an exact match against /expert/apply', () => {
    expect(hasPendingApplyIntent(PENDING_APPLY_PATH)).toBe(true);
    expect(hasPendingApplyIntent('/expert/apply')).toBe(true);
  });

  it('is false for null, undefined, or anything else — including a lookalike or trailing content', () => {
    expect(hasPendingApplyIntent(null)).toBe(false);
    expect(hasPendingApplyIntent(undefined)).toBe(false);
    expect(hasPendingApplyIntent('')).toBe(false);
    expect(hasPendingApplyIntent('/expert/apply/')).toBe(false);
    expect(hasPendingApplyIntent('/expert/apply?step=agency')).toBe(false);
    expect(hasPendingApplyIntent('https://evil.example/expert/apply')).toBe(false);
    expect(hasPendingApplyIntent('/dashboard')).toBe(false);
  });
});
