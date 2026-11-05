'use client';

import { createContext, useContext, useMemo } from 'react';
import { extractCityFromTimezone, zonesDiffer } from '@balo/shared/timezone';
import { useDeviceTimezone } from '@/hooks/use-device-timezone';

/**
 * The visible zone label for a device-zone time, or `null` when no label is due. The default is
 * `null`, so a tree with no provider (guest recap, booking outside the dashboard) renders
 * exactly as it did before the provider existed.
 */
const ViewerZoneLabelContext = createContext<string | null>(null);

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

  const label = useMemo(() => {
    if (!savedTimezone || !device) return null;
    if (!zonesDiffer(savedTimezone, device, new Date())) return null;
    return extractCityFromTimezone(device) ?? device;
  }, [savedTimezone, device]);

  return (
    <ViewerZoneLabelContext.Provider value={label}>{children}</ViewerZoneLabelContext.Provider>
  );
}

export function useViewerZoneLabel(): string | null {
  return useContext(ViewerZoneLabelContext);
}
