'use client';

import { useEffect, useRef } from 'react';
import { track, ADMIN_LOOKUP_EVENTS } from '@/lib/analytics';
import type { LookupEntityType, LookupTypeFilter } from '@balo/shared/lookup';
import { classifyLookupQuery } from '../_lib/lookup-view';
import type { LookupDrillInTab } from './lookup-drill-in-tabs';

/**
 * Analytics-only client island (renders null) — the only way the Lookup surface fires
 * `track()`. Mirrors `admin-engagements-analytics.tsx`'s `useRef` dedupe shape, extended to
 * THREE independent events:
 *
 *  - `admin_lookup_searched` fires once per settled `(query, typeFilter)` PAIR — a `useRef`
 *    holds the last-fired pair key, so a re-render with the same pair does not re-fire, but
 *    either changing. Never fires for an empty query (that is the Recent view, not a search).
 *  - `admin_lookup_opened` fires once per selection `seq` — the shell increments `seq` on
 *    every select (search hit or Recent), including re-selecting the same row, so each open is
 *    its own event.
 *  - `admin_lookup_tab_selected` (BAL-555) fires once per EXPLICIT tab click, never on the
 *    default render — BAL-551 rendered Money inline; BAL-555 hides it behind a click, a
 *    discoverability regression this event is the only way to see.
 *
 * ⚠ THE QUERY STRING ITSELF IS NEVER A PROPERTY. It routinely contains an email address or a
 * person's name. Only `classifyLookupQuery`'s three-way shape classification crosses to
 * PostHog — the same rule as `page.tsx`'s `log.error`, which logs `queryLength`, not `query`.
 */

export interface LookupOpenedSelection {
  readonly entityType: LookupEntityType;
  readonly via: 'search' | 'recent';
  /** Bumped by the shell on every select, so a re-open of the same row still fires. */
  readonly seq: number;
}

export interface LookupTabSelected {
  readonly tab: LookupDrillInTab;
  readonly entityType: LookupEntityType;
  /** Bumped by the shell's shared `seqRef` on every EXPLICIT tab click. */
  readonly seq: number;
}

interface LookupAnalyticsProps {
  readonly query: string;
  readonly typeFilter: LookupTypeFilter;
  /** The result count AFTER the chip filter — what the viewer is actually looking at. */
  readonly resultCount: number;
  readonly opened: LookupOpenedSelection | null;
  /** BAL-555 — null until the viewer explicitly clicks a tab; never fires on the default render. */
  readonly tabSelected: LookupTabSelected | null;
}

export function LookupAnalytics({
  query,
  typeFilter,
  resultCount,
  opened,
  tabSelected,
}: Readonly<LookupAnalyticsProps>): null {
  const firedSearchFor = useRef<string | null>(null);
  const firedOpenSeq = useRef<number | null>(null);
  const firedTabSeq = useRef<number | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === '') return;
    const pairKey = `${trimmed}\x00${typeFilter}`;
    if (firedSearchFor.current === pairKey) return;
    firedSearchFor.current = pairKey;

    track(ADMIN_LOOKUP_EVENTS.SEARCHED, {
      result_count: resultCount,
      type_filter: typeFilter,
      matched_by: classifyLookupQuery(query),
    });
  }, [query, typeFilter, resultCount]);

  useEffect(() => {
    if (opened === null) return;
    if (firedOpenSeq.current === opened.seq) return;
    firedOpenSeq.current = opened.seq;

    track(ADMIN_LOOKUP_EVENTS.OPENED, {
      entity_type: opened.entityType,
      via: opened.via,
    });
  }, [opened]);

  useEffect(() => {
    if (tabSelected === null) return;
    if (firedTabSeq.current === tabSelected.seq) return;
    firedTabSeq.current = tabSelected.seq;

    track(ADMIN_LOOKUP_EVENTS.TAB_SELECTED, {
      entity_type: tabSelected.entityType,
      tab: tabSelected.tab,
    });
  }, [tabSelected]);

  return null;
}
