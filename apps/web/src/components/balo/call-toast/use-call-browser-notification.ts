'use client';

import { useEffect } from 'react';
import { CALL_TOAST_COPY } from '@/lib/call-now/call-toast-copy';
import type { RingingToastView } from './call-toast-model';

/**
 * While a ring is live and the tab is hidden, raises a browser notification so the callee can
 * answer from another tab or app. It needs permission already `granted` (asked on the caller's
 * first use of Call now), and does nothing where the API is absent. The `tag` is per ring, so
 * several open tabs raise one notification, not one each. A click focuses this window; the
 * notification closes when the ring ends or the toast goes away.
 */
export function useCallBrowserNotification(ring: RingingToastView | null): void {
  const ringId = ring?.ringId ?? null;
  const callerLabel = ring?.callerLabel ?? null;
  const caseTitle = ring?.caseTitle ?? null;

  useEffect(() => {
    if (ringId === null || callerLabel === null) return undefined;
    if (!('Notification' in globalThis)) return undefined;

    let shown: Notification | null = null;

    const show = (): void => {
      if (shown !== null || document.visibilityState !== 'hidden') return;
      if (globalThis.Notification.permission !== 'granted') return;
      try {
        shown = new globalThis.Notification(CALL_TOAST_COPY.browserTitle(callerLabel), {
          body: CALL_TOAST_COPY.browserBody(caseTitle),
          tag: `balo-call-${ringId}`,
        });
        shown.onclick = () => {
          globalThis.focus();
          shown?.close();
        };
      } catch {
        shown = null;
      }
    };

    show();
    document.addEventListener('visibilitychange', show);
    return () => {
      document.removeEventListener('visibilitychange', show);
      shown?.close();
    };
  }, [ringId, callerLabel, caseTitle]);
}
