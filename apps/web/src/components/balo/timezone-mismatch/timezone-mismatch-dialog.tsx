'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Calendar, Globe, Info } from 'lucide-react';
import { zonesDiffer } from '@balo/shared/timezone';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { useDeviceTimezone } from '@/hooks/use-device-timezone';
import { useViewerClock } from '@/hooks/use-viewer-clock';
import { track, SCHEDULE_EVENTS } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import type { WeeklyRange } from '@/lib/timezone/common-weekly-range';
import { getTimezoneImpactAction } from '@/app/(dashboard)/expert/settings/_actions/get-timezone-impact';
import { ConsultationCheck, type ConsultationCheckState } from './consultation-check';
import {
  BUSY_CALENDAR_LINE,
  consequenceBody,
  consequenceHeading,
  keepLabel,
  mismatchDescription,
  mismatchTitle,
  switchLabel,
  timeOffLine,
  travellingHint,
} from './mismatch-lib';

export interface TimezoneMismatchDialogProps {
  open: boolean;
  /** `detected`: the layout noticed the device zone changed. `manual`: the expert picked a
   *  zone on the Schedule tab. Only the heading and the travel hint differ. */
  source: 'detected' | 'manual';
  expertProfileId: string;
  /** The zone the saved hours are read in. */
  fromTimezone: string;
  /** The zone the hours would be re-read in. */
  toTimezone: string;
  /** The hours the expert usually works, shown in both zones. */
  commonRange: WeeklyRange | null;
  /** Dismissed without switching — Keep or Escape. */
  onKeep: () => void;
  onSwitch: () => void;
}

const BUTTON_CLASS = 'max-sm:h-11 max-sm:w-full';

/**
 * One decision, consequences included: keep the hours where they are, or read them in the
 * zone the expert is in. Both buttons carry equal weight because travelling and moving look
 * the same from here, and Keep takes initial focus (the AlertDialog's cancel) so Enter or
 * Escape never switches.
 *
 * The consultation check warns and never blocks: it fails open, and Switch stays enabled
 * while it runs or if it fails.
 */
export function TimezoneMismatchDialog({
  open,
  source,
  expertProfileId,
  fromTimezone,
  toTimezone,
  commonRange,
  onKeep,
  onSwitch,
}: Readonly<TimezoneMismatchDialogProps>): React.JSX.Element {
  const [check, setCheck] = useState<ConsultationCheckState>('checking');
  const viaEscapeRef = useRef(false);
  const resolvedRef = useRef(false);
  const wasOpenRef = useRef(false);

  const affectedConsultations = typeof check === 'object' ? check.affectedCount : null;

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      viaEscapeRef.current = false;
      resolvedRef.current = false;
      track(SCHEDULE_EVENTS.TIMEZONE_MISMATCH_SHOWN, {
        expert_id: expertProfileId,
        from_timezone: fromTimezone,
        to_timezone: toTimezone,
        source,
      });
    }
    wasOpenRef.current = open;
  }, [open, expertProfileId, fromTimezone, toTimezone, source]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCheck('checking');
    getTimezoneImpactAction({ timezone: toTimezone })
      .then((report) => {
        if (!cancelled) setCheck(report ?? 'failed');
      })
      .catch(() => {
        if (!cancelled) setCheck('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [open, toTimezone]);

  const trackResolved = useCallback(
    (action: 'kept' | 'switched'): void => {
      resolvedRef.current = true;
      track(SCHEDULE_EVENTS.TIMEZONE_MISMATCH_RESOLVED, {
        expert_id: expertProfileId,
        from_timezone: fromTimezone,
        to_timezone: toTimezone,
        source,
        action,
        via_escape: action === 'kept' && viaEscapeRef.current,
        affected_consultations: affectedConsultations,
      });
    },
    [expertProfileId, fromTimezone, toTimezone, source, affectedConsultations]
  );

  // Switch's Radix action also closes the dialog, so a close that follows a resolution is
  // ignored rather than recorded as a second, contradictory answer.
  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (next || resolvedRef.current) return;
      trackResolved('kept');
      onKeep();
    },
    [trackResolved, onKeep]
  );

  const handleSwitch = useCallback((): void => {
    trackResolved('switched');
    onSwitch();
  }, [trackResolved, onSwitch]);

  const handleEscape = useCallback((): void => {
    viaEscapeRef.current = true;
  }, []);

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        onEscapeKeyDown={handleEscape}
        className="max-h-[92dvh] overflow-y-auto p-[22px] max-sm:top-auto max-sm:bottom-0 max-sm:max-w-none max-sm:translate-y-0 max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:pb-[calc(22px+env(safe-area-inset-bottom))] sm:max-w-[520px]"
      >
        <MismatchBody
          source={source}
          fromTimezone={fromTimezone}
          toTimezone={toTimezone}
          commonRange={commonRange}
          check={check}
        />
        <AlertDialogFooter className="flex-col sm:flex-row">
          <AlertDialogCancel className={BUTTON_CLASS}>{keepLabel(fromTimezone)}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleSwitch}
            className={cn(buttonVariants({ variant: 'outline' }), BUTTON_CLASS)}
          >
            {switchLabel(toTimezone)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface MismatchBodyProps {
  source: 'detected' | 'manual';
  fromTimezone: string;
  toTimezone: string;
  commonRange: WeeklyRange | null;
  check: ConsultationCheckState;
}

/** Mounted only while the dialog is open, so its minute clock runs only while it is read. */
function MismatchBody({
  source,
  fromTimezone,
  toTimezone,
  commonRange,
  check,
}: Readonly<MismatchBodyProps>): React.JSX.Element {
  const clock = useViewerClock();
  const device = useDeviceTimezone();
  const [openedAt] = useState(() => new Date());
  const now = clock?.now ?? openedAt;
  const toIsDevice = device !== null && !zonesDiffer(toTimezone, device, now);
  const nextTimeOff = typeof check === 'object' ? check.nextTimeOff : null;

  return (
    <>
      <div className="flex items-start gap-3">
        <div className="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-[10px]">
          <Globe className="text-primary size-[18px]" aria-hidden="true" />
        </div>
        <div>
          <AlertDialogTitle className="text-[17px] leading-snug font-semibold">
            {mismatchTitle(source, fromTimezone, toTimezone)}
          </AlertDialogTitle>
          <AlertDialogDescription className="mt-1.5 text-[13.5px] leading-relaxed">
            {mismatchDescription({ fromTimezone, toTimezone, commonRange, now, toIsDevice })}
          </AlertDialogDescription>
        </div>
      </div>

      <div className="bg-muted/40 border-border flex flex-col gap-2.5 rounded-xl border px-4 py-3.5">
        <div>
          <p className="text-foreground text-[13.5px] font-semibold">
            {consequenceHeading(toTimezone)}
          </p>
          <p className="text-muted-foreground mt-0.5 text-[13px] leading-normal">
            {consequenceBody(fromTimezone, toTimezone, commonRange, now)}
          </p>
        </div>
        <div aria-live="polite">
          <ConsultationCheck state={check} toTimezone={toTimezone} />
        </div>
        {nextTimeOff !== null && (
          <div className="flex items-start gap-2">
            <Calendar
              className="text-muted-foreground mt-[3px] size-3.5 shrink-0"
              aria-hidden="true"
            />
            <p className="text-muted-foreground text-[13px] leading-normal">
              {timeOffLine(nextTimeOff, toTimezone)}
            </p>
          </div>
        )}
        <div className="flex items-start gap-2">
          <Info className="text-muted-foreground mt-[3px] size-3.5 shrink-0" aria-hidden="true" />
          <p className="text-muted-foreground text-[13px] leading-normal">{BUSY_CALENDAR_LINE}</p>
        </div>
      </div>

      {source === 'detected' && (
        <p className="text-muted-foreground text-[12.5px] leading-normal">
          {travellingHint(fromTimezone)}
        </p>
      )}
    </>
  );
}
