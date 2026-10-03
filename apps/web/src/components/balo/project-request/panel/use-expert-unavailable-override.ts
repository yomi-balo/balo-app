'use client';

import { useCallback, useMemo, useState } from 'react';
import type { ProjectRequestExpert } from './send-to-selector';

interface UseExpertUnavailableOverrideResult {
  /** The expert as the panel should treat them: unavailable once a Direct submit was refused. */
  effectiveExpert: ProjectRequestExpert | undefined;
  /** Which surface raised the unavailable notice: the profile's own data, or a refused submit. */
  unavailableTrigger: 'profile_data' | 'submit_rejected';
  /** Call when a Direct submit is refused because the expert became unavailable after load. */
  markUnavailable: () => void;
  /** Call on each open so a previous refusal does not carry over. */
  resetOverride: () => void;
}

/**
 * Tracks a Direct submit refused because the expert became unavailable after the page loaded. The
 * panel then treats the expert exactly as it does one the profile reported as unavailable, so the
 * notice and "Get matched instead" take over from the stale card.
 */
export function useExpertUnavailableOverride(
  expert: ProjectRequestExpert | undefined
): UseExpertUnavailableOverrideResult {
  const [overridden, setOverridden] = useState(false);
  const effectiveExpert = useMemo(
    () => (expert !== undefined && overridden ? { ...expert, availableForWork: false } : expert),
    [expert, overridden]
  );
  const markUnavailable = useCallback(() => setOverridden(true), []);
  const resetOverride = useCallback(() => setOverridden(false), []);
  return {
    effectiveExpert,
    unavailableTrigger: overridden ? 'submit_rejected' : 'profile_data',
    markUnavailable,
    resetOverride,
  };
}
