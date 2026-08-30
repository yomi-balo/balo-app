'use client';

import { useEffect } from 'react';
import type { MarketingHomeSection } from '@/lib/analytics';
import { useMarketingHomeTracking } from '@/components/marketing/use-marketing-home-tracking';

/** Matches `expert-profile-analytics.tsx`'s section-viewed threshold (`:65`). */
const SECTION_VIEW_THRESHOLD = 0.25;

interface SectionViewTrackerProps {
  readonly sections: readonly MarketingHomeSection[];
}

/**
 * BAL-493 §3 / §10.7 — renders `null`. Fires `marketing_home_section_viewed` once per section,
 * modelled verbatim on `experts/[username]/_components/expert-profile-analytics.tsx`'s section
 * `IntersectionObserver` (one `track()` per section id, de-duplicated via a `Set`, disconnected
 * on unmount).
 *
 * ⚠ ONE DIFFERENCE from that model: section ids on THIS page ARE the tracked values directly —
 * `MARKETING_HOME_SECTIONS`'s own docblock states it "doubles as the page's section anchor
 * ids" (`page.tsx` renders `id={section}` from the same tuple). So this observes
 * `document.getElementById(section)` with no `section-` prefix, unlike the profile page's
 * `section-${key}` convention.
 *
 * Dispatches through `useMarketingHomeTracking` (the ONE dispatch point for this page's seven
 * events) rather than calling `track()` directly.
 */
export function SectionViewTracker({ sections }: Readonly<SectionViewTrackerProps>): null {
  const tracking = useMarketingHomeTracking();

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const seen = new Set<MarketingHomeSection>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = entry.target.id as MarketingHomeSection;
          if (seen.has(id)) continue;
          seen.add(id);
          tracking.sectionViewed(id);
        }
      },
      { threshold: SECTION_VIEW_THRESHOLD }
    );

    for (const section of sections) {
      const el = document.getElementById(section);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [sections, tracking]);

  return null;
}
