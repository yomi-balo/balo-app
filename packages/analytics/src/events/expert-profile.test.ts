import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  EXPERT_PROFILE_EVENTS,
  type ExpertProfileCta,
  type ExpertReviewsFilter,
} from './expert-profile';

describe('EXPERT_PROFILE_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(EXPERT_PROFILE_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'BOOKING_UNAVAILABLE_SHOWN',
      'PROFILE_CTA_CLICKED',
      'PROFILE_CTA_IMPRESSION',
      'PROFILE_SECTION_VIEWED',
      'PROFILE_VIEWED',
      'REVIEWS_FILTER_SELECTED',
      'REVIEWS_SHOW_MORE',
      'REVIEWS_VERIFIED_INFO_OPENED',
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
    expect(EXPERT_PROFILE_EVENTS.REVIEWS_FILTER_SELECTED).toBe('expert_reviews_filter_selected');
    expect(EXPERT_PROFILE_EVENTS.REVIEWS_SHOW_MORE).toBe('expert_reviews_show_more');
    expect(EXPERT_PROFILE_EVENTS.REVIEWS_VERIFIED_INFO_OPENED).toBe(
      'expert_reviews_verified_info_opened'
    );
  });

  it('values follow the naming convention expert_(profile|reviews)_{noun}(_{noun})*', () => {
    for (const value of Object.values(EXPERT_PROFILE_EVENTS)) {
      expect(value).toMatch(/^expert_(profile|reviews)_[a-z]+(_[a-z]+)*$/);
    }
  });

  it('the CTA vocabulary includes the unavailable-state alternatives', () => {
    expectTypeOf<
      'book' | 'project' | 'quickstart' | 'message' | 'find_similar' | 'match_project'
    >().toEqualTypeOf<ExpertProfileCta>();
  });

  it('the reviews filter vocabulary is all | project | case', () => {
    expectTypeOf<'all' | 'project' | 'case'>().toEqualTypeOf<ExpertReviewsFilter>();
  });
});
