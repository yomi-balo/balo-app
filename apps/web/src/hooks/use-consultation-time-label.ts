'use client';

import { useEffect, useState } from 'react';

/**
 * BAL-573 — the ABSOLUTE date/time string for one consultation's `scheduledStartIso`, never
 * "Tomorrow" — an overnight dwell would make a control's name built from it a lie.
 *
 * ⚠⚠ EXTRACTED FROM `consultation-row-menu.tsx`'s `useMenuLabel` so the kebab's label and the
 * row's guest-count control's label cannot drift — both build their accessible name from THIS
 * one string.
 *
 * Renders in UTC first, like `LocalDateTime`, then upgrades to the viewer's timezone in an
 * effect so hydration cannot mismatch the attribute.
 */
export function useAbsoluteConsultationTime(scheduledStartIso: string): string {
  const [zone, setZone] = useState('UTC');
  useEffect(() => {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved) setZone(resolved);
  }, []);
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(scheduledStartIso));
}
