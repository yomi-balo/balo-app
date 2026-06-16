'use client';

import { useEffect, useRef } from 'react';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import type { ProjectsInboxLens } from '@/lib/analytics';

/** sessionStorage key seeding `time_to_first_action_ms` (read on first CTA click). */
export const INBOX_VIEWED_AT_KEY = 'balo:inbox-viewed-at';

interface ProjectsInboxAnalyticsProps {
  lens: ProjectsInboxLens;
  needsCount: number;
  inProgressCount: number;
  totalCount: number;
}

/**
 * Analytics-only client island (renders null) — the only way a server-rendered
 * dashboard can fire `track()`. On mount it emits `projects_inbox_viewed` once
 * per (lens) and seeds a `sessionStorage` timestamp the first hero-CTA / list-row
 * click reads to compute `time_to_first_action_ms` (mirrors the detail island).
 */
export function ProjectsInboxAnalytics({
  lens,
  needsCount,
  inProgressCount,
  totalCount,
}: Readonly<ProjectsInboxAnalyticsProps>): null {
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (firedFor.current === lens) return;
    firedFor.current = lens;

    // Seed the first-action clock — best-effort (private mode may throw).
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem(INBOX_VIEWED_AT_KEY, String(Date.now()));
      } catch {
        // sessionStorage unavailable — time_to_first_action_ms simply stays null.
      }
    }

    track(PROJECTS_INBOX_EVENTS.INBOX_VIEWED, {
      lens,
      needs_count: needsCount,
      in_progress_count: inProgressCount,
      total_count: totalCount,
    });
  }, [lens, needsCount, inProgressCount, totalCount]);

  return null;
}

/** Read + clear the seeded view timestamp → ms since view, or null. */
export function readTimeToFirstAction(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const seeded = window.sessionStorage.getItem(INBOX_VIEWED_AT_KEY);
    if (seeded === null) return null;
    window.sessionStorage.removeItem(INBOX_VIEWED_AT_KEY);
    const parsed = Number.parseInt(seeded, 10);
    if (Number.isNaN(parsed)) return null;
    return Date.now() - parsed;
  } catch {
    return null;
  }
}
