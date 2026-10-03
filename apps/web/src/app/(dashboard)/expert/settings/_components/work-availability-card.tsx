'use client';

import { useCallback, useId, useState } from 'react';
import { Check, Pause } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { PauseWorkDialog } from './pause-work-dialog';
import type { WorkInFlight } from '../_types/schedule';

const AVAILABLE_COPY = 'Clients can book consultations with you and send you project briefs.';
const PAUSED_COPY =
  "You're paused. Clients can't book consultations or send you new project briefs. Your current consultations and projects carry on as normal.";

interface WorkAvailabilityCardProps {
  available: boolean;
  workInFlight: WorkInFlight;
  /** True while a change is being written; the switch is inert for that window. */
  saving: boolean;
  /** Turn availability back on. Applies at once, no dialog. */
  onResume: () => void;
  /** The expert confirmed the pause dialog. */
  onPause: () => void;
  /** The pause dialog was dismissed without pausing. */
  onPauseCancelled: () => void;
}

/**
 * The "Available for new work" status card. Turning it off opens a confirmation first and
 * nothing is written until the expert confirms; turning it on applies immediately. Paused
 * reads as deliberate rather than broken: the shared hatch plus a "Paused" pill.
 */
export function WorkAvailabilityCard({
  available,
  workInFlight,
  saving,
  onResume,
  onPause,
  onPauseCancelled,
}: Readonly<WorkAvailabilityCardProps>): React.JSX.Element {
  const switchId = useId();
  const descId = `${switchId}-desc`;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const paused = !available;
  const StatusIcon = paused ? Pause : Check;

  const handleCheckedChange = useCallback(
    (next: boolean): void => {
      if (next) {
        onResume();
        return;
      }
      setConfirmOpen(true);
    },
    [onResume]
  );

  const handleConfirm = useCallback((): void => {
    setConfirmOpen(false);
    onPause();
  }, [onPause]);

  const handleCancel = useCallback((): void => {
    setConfirmOpen(false);
    onPauseCancelled();
  }, [onPauseCancelled]);

  return (
    <section
      aria-label="Availability for new work"
      className={cn(
        'flex items-start gap-3.5 rounded-[14px] border px-[22px] py-[18px] shadow-xs transition-colors',
        paused ? 'bg-paused-hatch border-paused-border' : 'bg-card border-border'
      )}
    >
      <div
        className={cn(
          'flex size-[34px] shrink-0 items-center justify-center rounded-[9px]',
          paused ? 'bg-paused-border/60 text-foreground/70' : 'bg-success/10 text-success'
        )}
      >
        <StatusIcon className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={switchId}
            className="text-foreground cursor-pointer text-[15px] font-semibold"
          >
            Available for new work
          </label>
          {paused && (
            <span className="bg-card border-paused-border text-foreground/75 rounded-full border px-[9px] py-0.5 text-[11.5px] font-semibold">
              Paused
            </span>
          )}
        </div>
        <p
          id={descId}
          aria-live="polite"
          className="text-muted-foreground mt-1 max-w-[520px] text-[13px] leading-relaxed"
        >
          {available ? AVAILABLE_COPY : PAUSED_COPY}
        </p>
      </div>
      <Switch
        id={switchId}
        checked={available}
        disabled={saving}
        onCheckedChange={handleCheckedChange}
        aria-describedby={descId}
      />
      <PauseWorkDialog
        open={confirmOpen}
        workInFlight={workInFlight}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </section>
  );
}
