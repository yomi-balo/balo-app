'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { toast } from 'sonner';
import { zonesDiffer } from '@balo/shared/timezone';
import { useDeviceTimezone } from '@/hooks/use-device-timezone';
import { track, SCHEDULE_EVENTS } from '@/lib/analytics';
import type { MismatchPrompt } from '@/lib/timezone/load-viewer-timezone-context';
import { updateScheduleTimezoneAction } from '@/app/(dashboard)/expert/settings/_actions/update-schedule-timezone';
import { TimezoneMismatchDialog } from './timezone-mismatch-dialog';
import { isMismatchAnswered, markMismatchAnswered } from './mismatch-dismissal';
import { cityOf, switchedToast, SCHEDULE_TIMEZONE_CHANGED_EVENT } from './mismatch-lib';

const UPDATING_TOAST = 'Updating your timezone…';
const FAILED_TOAST = 'Failed to update timezone';
const RETRY_HINT = 'Try again from Expert settings → Schedule.';

interface TimezoneMismatchGateProps {
  mismatchPrompt: Pick<MismatchPrompt, 'expertProfileId' | 'scheduleTimezone' | 'commonRange'>;
}

/**
 * Asks an expert whose device zone differs from their schedule zone whether to keep or switch
 * their hours. It opens on page load, or on the next route change when the zone only changed
 * while the tab was in the background, so it never lands on top of whatever the expert was
 * mid-way through. Calls and the lobby live outside the dashboard layout, so they never mount it.
 */
export function TimezoneMismatchGate({
  mismatchPrompt,
}: Readonly<TimezoneMismatchGateProps>): React.JSX.Element {
  const { expertProfileId, scheduleTimezone, commonRange } = mismatchPrompt;
  const device = useDeviceTimezone();
  const pathname = usePathname();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const previousDeviceRef = useRef<string | null>(null);
  const previousPathnameRef = useRef(pathname);

  const isDue = useCallback(
    (deviceZone: string): boolean =>
      zonesDiffer(scheduleTimezone, deviceZone, new Date()) &&
      !isMismatchAnswered(scheduleTimezone, deviceZone),
    [scheduleTimezone]
  );

  useEffect(() => {
    if (device === null || device === previousDeviceRef.current) return;
    const isFirstReading = previousDeviceRef.current === null;
    previousDeviceRef.current = device;

    const due = isDue(device);
    if (isFirstReading) {
      setOpen(due);
      return;
    }
    setPending(due);
  }, [device, isDue]);

  useEffect(() => {
    if (pathname === previousPathnameRef.current) return;
    previousPathnameRef.current = pathname;
    if (!pending) return;
    setPending(false);
    if (device !== null && isDue(device)) setOpen(true);
  }, [pathname, pending, device, isDue]);

  const target = device ?? scheduleTimezone;

  const handleKeep = useCallback((): void => {
    if (device !== null) markMismatchAnswered(scheduleTimezone, device);
    setOpen(false);
  }, [device, scheduleTimezone]);

  const handleSwitch = useCallback(async (): Promise<void> => {
    setOpen(false);
    if (device === null) return;
    const toastId = toast.loading(UPDATING_TOAST);
    try {
      const result = await updateScheduleTimezoneAction(device);
      if (!result.success) {
        toast.error(result.error ?? FAILED_TOAST, { id: toastId, description: RETRY_HINT });
        return;
      }
      toast.success(switchedToast(cityOf(device)), { id: toastId });
      track(SCHEDULE_EVENTS.TIMEZONE_CHANGED, {
        expert_id: expertProfileId,
        from_timezone: scheduleTimezone,
        to_timezone: device,
        source: 'mismatch_dialog',
      });
      globalThis.dispatchEvent(new Event(SCHEDULE_TIMEZONE_CHANGED_EVENT));
      router.refresh();
    } catch (error) {
      Sentry.captureException(error);
      toast.error(FAILED_TOAST, { id: toastId, description: RETRY_HINT });
    }
  }, [device, expertProfileId, scheduleTimezone, router]);

  return (
    <TimezoneMismatchDialog
      open={open}
      source="detected"
      expertProfileId={expertProfileId}
      fromTimezone={scheduleTimezone}
      toTimezone={target}
      commonRange={commonRange}
      onKeep={handleKeep}
      onSwitch={handleSwitch}
    />
  );
}
