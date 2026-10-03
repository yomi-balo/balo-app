export const EXPERT_PROFILE_EVENTS = {
  PROFILE_VIEWED: 'expert_profile_viewed',
  PROFILE_SECTION_VIEWED: 'expert_profile_section_viewed',
  PROFILE_CTA_IMPRESSION: 'expert_profile_cta_impression',
  PROFILE_CTA_CLICKED: 'expert_profile_cta_clicked',
  // BAL-591 — the booking card's unavailable state (expert has paused new work).
  BOOKING_UNAVAILABLE_SHOWN: 'expert_profile_booking_unavailable_shown',
} as const;

export type ExpertProfileSection = 'about' | 'expertise' | 'quickstarts' | 'work' | 'reviews';
export type ExpertProfileCta =
  | 'book'
  | 'project'
  | 'quickstart'
  | 'message'
  | 'find_similar'
  | 'match_project';
export type ProfileViewport = 'desktop' | 'mobile';

export interface ExpertProfileEventMap {
  [EXPERT_PROFILE_EVENTS.PROFILE_VIEWED]: {
    expert_id: string;
    agency_id: string | null;
    referrer: string | null;
    is_logged_in: boolean;
    viewport: ProfileViewport;
  };
  [EXPERT_PROFILE_EVENTS.PROFILE_SECTION_VIEWED]: {
    expert_id: string;
    section: ExpertProfileSection;
  };
  [EXPERT_PROFILE_EVENTS.PROFILE_CTA_IMPRESSION]: {
    expert_id: string;
    cta: ExpertProfileCta;
  };
  [EXPERT_PROFILE_EVENTS.PROFILE_CTA_CLICKED]: {
    expert_id: string;
    cta: ExpertProfileCta;
  };
  [EXPERT_PROFILE_EVENTS.BOOKING_UNAVAILABLE_SHOWN]: {
    expert_id: string;
  };
}
