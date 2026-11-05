'use client';

import { useEffect, useState } from 'react';
import { canonicalTimezone } from '@balo/shared/timezone';

function readDeviceTimezone(): string | null {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!resolved) return null;
  return canonicalTimezone(resolved) ?? resolved;
}

/**
 * The device's IANA timezone, canonicalised so an alias never reads as a different zone.
 *
 * `null` on the server pass and the first client render (identical markup, no hydration
 * mismatch), then resolved after mount. It re-reads when the window regains focus or the tab
 * becomes visible, because a traveller changes the OS zone while the page stays open. State
 * only changes when the value does, so a focus event on an unchanged zone re-renders nothing.
 */
export function useDeviceTimezone(): string | null {
  const [device, setDevice] = useState<string | null>(null);

  useEffect(() => {
    function sync(): void {
      setDevice(readDeviceTimezone());
    }
    function onVisibilityChange(): void {
      if (document.visibilityState === 'visible') sync();
    }
    sync();
    globalThis.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      globalThis.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return device;
}
