'use client';

import { useEffect, useRef } from 'react';
import {
  track,
  EXPERT_PROFILE_EVENTS,
  type ProfileViewport,
  type ExpertProfileSection,
} from '@/lib/analytics';

interface ExpertProfileAnalyticsProps {
  expertId: string;
  agencyId: string | null;
  viewport: ProfileViewport;
  isLoggedIn: boolean;
  /** Mounted section keys (matches the scroll-spy set). */
  sections: ExpertProfileSection[];
}

/**
 * Analytics-only client child (renders null). Mirrors `zero-results-tracker`:
 *   - fires `expert_profile_viewed` once on mount
 *   - fires `expert_profile_section_viewed` once per section as it enters the
 *     viewport (via IntersectionObserver on the section anchors `#section-{key}`)
 */
export function ExpertProfileAnalytics({
  expertId,
  agencyId,
  viewport,
  isLoggedIn,
  sections,
}: Readonly<ExpertProfileAnalyticsProps>): null {
  const viewedFired = useRef(false);

  useEffect(() => {
    if (viewedFired.current) return;
    viewedFired.current = true;
    track(EXPERT_PROFILE_EVENTS.PROFILE_VIEWED, {
      expert_id: expertId,
      agency_id: agencyId,
      referrer: typeof document !== 'undefined' ? document.referrer || null : null,
      is_logged_in: isLoggedIn,
      viewport,
    });
  }, [expertId, agencyId, isLoggedIn, viewport]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const seen = new Set<ExpertProfileSection>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries.filter((e) => e.isIntersecting)) {
          const key = (entry.target as HTMLElement).dataset.section as
            | ExpertProfileSection
            | undefined;
          if (key === undefined || seen.has(key)) continue;
          seen.add(key);
          track(EXPERT_PROFILE_EVENTS.PROFILE_SECTION_VIEWED, {
            expert_id: expertId,
            section: key,
          });
        }
      },
      { threshold: 0.25 }
    );

    for (const key of sections) {
      const el = document.getElementById(`section-${key}`);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [expertId, sections]);

  return null;
}
