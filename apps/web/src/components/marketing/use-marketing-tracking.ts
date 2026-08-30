'use client';

import { useMemo } from 'react';
import { track, MARKETING_EVENTS } from '@/lib/analytics';
import type { MarketingNavLink, MarketingSurface } from '@/lib/analytics';

export interface MarketingTracking {
  navClicked: (link: MarketingNavLink) => void;
  dashboardClicked: () => void;
}

/**
 * BAL-502 — the ONE dispatch point for the marketing chrome's events.
 *
 * ⚠ BAL-493 / D3 — `getStartedClicked` was removed from here (dead code): the signed-out
 * header CTA is now a plain `<Link href="/experts">` ("Find an expert"), which needs no
 * dispatch. `MARKETING_EVENTS.GET_STARTED_CLICKED` itself is KEPT and unemitted — the event
 * constant and this wrapper are different things (`packages/analytics/src/events/marketing.ts`).
 */
export function useMarketingTracking(surface: MarketingSurface): MarketingTracking {
  return useMemo(
    () => ({
      navClicked: (link: MarketingNavLink) => {
        track(MARKETING_EVENTS.NAV_CLICKED, { link, surface });
      },
      dashboardClicked: () => {
        track(MARKETING_EVENTS.DASHBOARD_CLICKED, { surface });
      },
    }),
    [surface]
  );
}
