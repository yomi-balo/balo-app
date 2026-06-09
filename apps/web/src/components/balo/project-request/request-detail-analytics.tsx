'use client';

import { useEffect, useRef } from 'react';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import type { RequestLens, RequestArchetype } from '@/lib/project-request/resolve-request-lens';

interface RequestDetailAnalyticsProps {
  requestId: string;
  lens: RequestLens;
  archetype: RequestArchetype;
  status: string;
  phase: 'phase1' | 'phase2';
}

/**
 * Analytics-only client island (renders null) — the ONLY interactivity A1 owns
 * (a server component can't call `track()`). Fires:
 *  - `project_request_detail_viewed` once on mount
 *  - `project_request_phase_flipped` the first time this viewer sees the request
 *    in Phase 2, guarded per (request, lens) via `sessionStorage` (the true
 *    server transition is captured separately by STATUS_TRANSITIONED)
 *  - `project_request_detail_dwell` on `visibilitychange→hidden` / `beforeunload`
 */
export function RequestDetailAnalytics({
  requestId,
  lens,
  archetype,
  status,
  phase,
}: Readonly<RequestDetailAnalyticsProps>): null {
  const viewedFired = useRef(false);
  const phaseFlipFired = useRef(false);
  const dwellFired = useRef(false);
  const mountedAt = useRef(0);

  // View on mount.
  useEffect(() => {
    if (viewedFired.current) return;
    viewedFired.current = true;
    mountedAt.current = Date.now();
    track(PROJECT_EVENTS.PROJECT_REQUEST_DETAIL_VIEWED, {
      request_id: requestId,
      lens,
      archetype,
      status,
      phase,
    });
  }, [requestId, lens, archetype, status, phase]);

  // Phase flip — first Phase-2 view per (request, lens). Two guards stack:
  //  - a per-mount `phaseFlipFired` ref ensures AT MOST ONCE per mount on EVERY
  //    storage path (so a throwing sessionStorage in private mode can't re-fire
  //    on every navigation), and
  //  - the cross-mount `sessionStorage` dedupe suppresses re-fires across mounts
  //    when storage is available.
  useEffect(() => {
    if (phase !== 'phase2') return;
    if (typeof window === 'undefined') return;
    if (phaseFlipFired.current) return;

    const key = `balo:phase-flipped:${requestId}:${lens}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, '1');
    } catch {
      // sessionStorage unavailable (private mode) — the per-mount ref below still
      // guarantees we fire at most once for this mount.
    }

    phaseFlipFired.current = true;
    track(PROJECT_EVENTS.PROJECT_REQUEST_PHASE_FLIPPED, {
      request_id: requestId,
      lens,
      from_phase: 'phase1',
      to_phase: 'phase2',
    });
  }, [requestId, lens, phase]);

  // Dwell — on tab hide / unload, once.
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const fireDwell = (): void => {
      if (dwellFired.current) return;
      dwellFired.current = true;
      track(PROJECT_EVENTS.PROJECT_REQUEST_DETAIL_DWELL, {
        request_id: requestId,
        lens,
        status,
        dwell_ms: Date.now() - mountedAt.current,
      });
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') fireDwell();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', fireDwell);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', fireDwell);
    };
  }, [requestId, lens, status]);

  return null;
}
