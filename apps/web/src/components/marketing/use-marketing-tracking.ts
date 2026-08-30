'use client';

import { useMemo } from 'react';
import { track, MARKETING_EVENTS } from '@/lib/analytics';
import type { MarketingNavLink, MarketingSurface } from '@/lib/analytics';

export interface MarketingTracking {
  navClicked: (link: MarketingNavLink) => void;
  dashboardClicked: () => void;
  getStartedClicked: () => void;
}

/** BAL-502 — the ONE dispatch point for the marketing chrome's three events. */
export function useMarketingTracking(surface: MarketingSurface): MarketingTracking {
  return useMemo(
    () => ({
      navClicked: (link: MarketingNavLink) => {
        track(MARKETING_EVENTS.NAV_CLICKED, { link, surface });
      },
      dashboardClicked: () => {
        track(MARKETING_EVENTS.DASHBOARD_CLICKED, { surface });
      },
      getStartedClicked: () => {
        track(MARKETING_EVENTS.GET_STARTED_CLICKED, { surface });
      },
    }),
    [surface]
  );
}
