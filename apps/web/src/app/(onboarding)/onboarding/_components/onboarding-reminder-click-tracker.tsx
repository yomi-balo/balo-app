'use client';

import { useEffect, useRef } from 'react';
import { track, ONBOARDING_REMINDER_EVENTS } from '@/lib/analytics';

interface OnboardingReminderClickTrackerProps {
  /** Cadence step of the reminder whose CTA was clicked (1 = +24h, 2 = +72h, 3 = +7d). */
  cadenceStep: 1 | 2 | 3;
  /** Domain class recomputed server-side from the user's email (no URL leak). */
  domainClass: 'corporate' | 'freemail';
}

/**
 * BAL-374 — fires `onboarding_reminder_clicked` ONCE per mount when a user lands on
 * `/onboarding` via a reminder CTA (`?src=onboarding_reminder&step=N`). Ref-guarded so
 * client-side navigation that keeps the param present (the wizard's `router.replace` on
 * step change remounts nothing) never re-fires. A hard browser refresh remounts the island
 * and will fire once more — the accepted once-per-mount impression semantics, not once-ever.
 * Renders nothing — a pure analytics island (mirrors the ref-guarded impression pattern in
 * the expert finish-card).
 */
export function OnboardingReminderClickTracker({
  cadenceStep,
  domainClass,
}: Readonly<OnboardingReminderClickTrackerProps>): null {
  const tracked = useRef(false);

  useEffect(() => {
    if (tracked.current) return;
    tracked.current = true;
    track(ONBOARDING_REMINDER_EVENTS.CLICKED, {
      cadence_step: cadenceStep,
      domain_class: domainClass,
    });
  }, [cadenceStep, domainClass]);

  return null;
}
