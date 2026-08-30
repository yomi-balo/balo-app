'use client';

import { useMemo } from 'react';
import { track, MARKETING_HOME_EVENTS } from '@/lib/analytics';
import type {
  MarketingHomeBenchRow,
  MarketingHomeCtaPlacement,
  MarketingHomeProductSource,
  MarketingHomeSection,
  MarketingHomeSpotlightAction,
} from '@/lib/analytics';

export interface MarketingHomeTracking {
  /** `query` is used ONLY for its length — the text itself is never emitted. */
  heroSearchSubmitted: (query: string, products: string[]) => void;
  heroFacetOpened: () => void;
  heroProductToggled: (
    product: string,
    source: MarketingHomeProductSource,
    selected: boolean
  ) => void;
  productTileClicked: (
    product: string,
    row: MarketingHomeBenchRow,
    position: number,
    countShown: boolean
  ) => void;
  spotlightExpertClicked: (
    expertId: string,
    action: MarketingHomeSpotlightAction,
    position: number
  ) => void;
  ctaClicked: (placement: MarketingHomeCtaPlacement, label: string) => void;
  sectionViewed: (section: MarketingHomeSection) => void;
}

/**
 * BAL-493 — THE ONE DISPATCH POINT for the marketing home page's seven events (mirrors
 * `useMarketingTracking`, the chrome's equivalent). **No island calls `track()` directly.**
 *
 * ⚠ It takes NO `surface` argument: the surface IS the home page. That is the whole reason
 * this is a separate family from `MARKETING_EVENTS`, whose pinned
 * `MARKETING_SURFACES = ['header','mobile_menu']` tuple types every one of its events.
 *
 * ⚠ PRIVACY: `heroSearchSubmitted` takes the raw query but emits ONLY `query_length`. Do not
 * add a property carrying the text — `composer-analytics.ts` states the rule verbatim for the
 * `/experts` composer and it holds identically here.
 *
 * ⚠ There is deliberately NO `nav` CTA verb. The header already emits
 * `MARKETING_EVENTS.NAV_CLICKED` via `useMarketingTracking`; a nav-placement `cta_clicked`
 * would be a second event for one click (pinned by `marketing-home.test.ts`).
 */
export function useMarketingHomeTracking(): MarketingHomeTracking {
  return useMemo(
    () => ({
      heroSearchSubmitted: (query: string, products: string[]) => {
        track(MARKETING_HOME_EVENTS.HERO_SEARCH_SUBMITTED, {
          query_length: query.length,
          product_count: products.length,
          products,
        });
      },
      heroFacetOpened: () => {
        track(MARKETING_HOME_EVENTS.HERO_FACET_OPENED, {});
      },
      heroProductToggled: (
        product: string,
        source: MarketingHomeProductSource,
        selected: boolean
      ) => {
        track(MARKETING_HOME_EVENTS.HERO_PRODUCT_TOGGLED, { product, source, selected });
      },
      productTileClicked: (
        product: string,
        row: MarketingHomeBenchRow,
        position: number,
        countShown: boolean
      ) => {
        track(MARKETING_HOME_EVENTS.PRODUCT_TILE_CLICKED, {
          product,
          row,
          position,
          count_shown: countShown,
        });
      },
      spotlightExpertClicked: (
        expertId: string,
        action: MarketingHomeSpotlightAction,
        position: number
      ) => {
        track(MARKETING_HOME_EVENTS.SPOTLIGHT_EXPERT_CLICKED, {
          expert_id: expertId,
          action,
          position,
        });
      },
      ctaClicked: (placement: MarketingHomeCtaPlacement, label: string) => {
        track(MARKETING_HOME_EVENTS.CTA_CLICKED, { placement, label });
      },
      sectionViewed: (section: MarketingHomeSection) => {
        track(MARKETING_HOME_EVENTS.SECTION_VIEWED, { section });
      },
    }),
    []
  );
}
