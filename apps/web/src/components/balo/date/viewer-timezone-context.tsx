'use client';

import { createContext, useContext, useMemo } from 'react';
import { extractCityFromTimezone, zonesDiffer } from '@balo/shared/timezone';
import { useDeviceTimezone } from '@/hooks/use-device-timezone';

interface ViewerTimezone {
  /** The visible zone label for a device-zone time, or `null` when no label is due. */
  label: string | null;
  /**
   * The canonical device zone the `label` was derived from, or `null` before it resolves. A
   * consumer that prints the label must format in THIS zone, so the text and the city beside it
   * can never name different places when the OS zone changes mid-session.
   */
  deviceZone: string | null;
}

/**
 * The default is all-`null`, so a tree with no provider (guest recap, booking outside the
 * dashboard) renders exactly as it did before the provider existed.
 */
const NO_VIEWER_TIMEZONE: ViewerTimezone = { label: null, deviceZone: null };

const ViewerTimezoneContext = createContext<ViewerTimezone>(NO_VIEWER_TIMEZONE);

interface ViewerTimezoneProviderProps {
  /** `users.timezone`, or `null` when the user never saved one. */
  savedTimezone: string | null;
  children: React.ReactNode;
}

/**
 * Supplies `LocalDateTime` with the city to print beside a device-zone time, but only while the
 * device zone genuinely differs from the saved one. With no saved zone there is nothing to
 * contrast against, so no label is shown.
 */
export function ViewerTimezoneProvider({
  savedTimezone,
  children,
}: Readonly<ViewerTimezoneProviderProps>): React.JSX.Element {
  const device = useDeviceTimezone();

  const value = useMemo<ViewerTimezone>(() => {
    if (!savedTimezone || !device || !zonesDiffer(savedTimezone, device, new Date())) {
      return { label: null, deviceZone: device };
    }
    return { label: extractCityFromTimezone(device) ?? device, deviceZone: device };
  }, [savedTimezone, device]);

  return <ViewerTimezoneContext.Provider value={value}>{children}</ViewerTimezoneContext.Provider>;
}

export function useViewerTimezone(): ViewerTimezone {
  return useContext(ViewerTimezoneContext);
}
