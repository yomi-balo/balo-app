import { describe, it, expect, expectTypeOf } from 'vitest';
import { EXPERT_PROFILE_EVENTS, type ExpertProfileCta } from './expert-profile';

describe('EXPERT_PROFILE_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(EXPERT_PROFILE_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'BOOKING_UNAVAILABLE_SHOWN',
      'PROFILE_CTA_CLICKED',
      'PROFILE_CTA_IMPRESSION',
      'PROFILE_SECTION_VIEWED',
      'PROFILE_VIEWED',
    ]);
  });

  it('maps each constant to its exact snake_case value', () => {
    expect(EXPERT_PROFILE_EVENTS.PROFILE_VIEWED).toBe('expert_profile_viewed');
    expect(EXPERT_PROFILE_EVENTS.PROFILE_SECTION_VIEWED).toBe('expert_profile_section_viewed');
    expect(EXPERT_PROFILE_EVENTS.PROFILE_CTA_IMPRESSION).toBe('expert_profile_cta_impression');
    expect(EXPERT_PROFILE_EVENTS.PROFILE_CTA_CLICKED).toBe('expert_profile_cta_clicked');
    expect(EXPERT_PROFILE_EVENTS.BOOKING_UNAVAILABLE_SHOWN).toBe(
      'expert_profile_booking_unavailable_shown'
    );
  });

  it('values follow the naming convention expert_profile_{noun}(_{noun})*', () => {
    for (const value of Object.values(EXPERT_PROFILE_EVENTS)) {
      expect(value).toMatch(/^expert_profile_[a-z]+(_[a-z]+)*$/);
    }
  });

  it('the CTA vocabulary includes the unavailable-state alternatives', () => {
    expectTypeOf<
      'book' | 'project' | 'quickstart' | 'message' | 'find_similar' | 'match_project'
    >().toEqualTypeOf<ExpertProfileCta>();
  });
});
