'use client';

import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { AvailabilitySlotDto, SlotDurationMinutes } from '@balo/shared/availability';
import type { AvailabilitySlotSelection } from '@/components/availability';
import { Button } from '@/components/ui/button';
import { LocalDateTime } from '@/components/balo/date/local-date-time';

/**
 * The shared "up to four suggestions" view both reschedule pickers open on, shown in place of
 * `ExpertAvailabilityCalendar` until "See more times". Purely presentational: `slots` is already
 * the `suggestTimes` output, and every button reports the SAME `AvailabilitySlotSelection` shape
 * `ExpertAvailabilityCalendar.onSlotSelect` does, so neither caller's pick handler needs to
 * branch on where the pick came from.
 */
export interface SuggestedTimesListProps {
  slots: readonly AvailabilitySlotDto[];
  /** Ladder-typed, matching `AvailabilitySlotSelection['duration']` — the caller only mounts
   *  this view once the meeting's length has passed the same ladder check `fixedDurationMinutes`
   *  does; an off-ladder length falls straight through to the calendar (zero suggestions). */
  durationMinutes: SlotDurationMinutes;
  /** `ProposeTimesDialog`: a pick ADDS to a list rather than advancing a step. */
  adds?: boolean;
  onPick: (selection: AvailabilitySlotSelection) => void;
  onSeeMore: () => void;
}

export function SuggestedTimesList({
  slots,
  durationMinutes,
  adds = false,
  onPick,
  onSeeMore,
}: Readonly<SuggestedTimesListProps>): React.JSX.Element {
  return (
    <div>
      <p className="text-muted-foreground mb-2 text-xs font-medium">Suggested times</p>
      <div className="flex flex-col gap-1.5">
        {slots.map((slot) => (
          <SuggestedTimeButton
            key={slot.start}
            slot={slot}
            durationMinutes={durationMinutes}
            adds={adds}
            onPick={onPick}
          />
        ))}
      </div>
      <Button type="button" variant="outline" className="mt-2 w-full" onClick={onSeeMore}>
        See more times
      </Button>
    </div>
  );
}

function SuggestedTimeButton({
  slot,
  durationMinutes,
  adds,
  onPick,
}: Readonly<{
  slot: AvailabilitySlotDto;
  durationMinutes: SlotDurationMinutes;
  adds: boolean;
  onPick: (selection: AvailabilitySlotSelection) => void;
}>): React.JSX.Element {
  const Trailing = adds ? Plus : ChevronRight;

  const handlePick = (): void => {
    const end = new Date(new Date(slot.start).getTime() + durationMinutes * 60_000).toISOString();
    onPick({ start: slot.start, end, duration: durationMinutes });
  };

  return (
    <button
      type="button"
      onClick={handlePick}
      className="border-border hover:border-primary hover:bg-primary/5 bg-card flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border px-3.5 py-2 text-left transition-colors"
    >
      <span className="text-foreground text-sm font-medium">
        <LocalDateTime
          iso={slot.start}
          variant="day-month-time-range"
          durationMinutes={durationMinutes}
        />
        {adds && <span className="sr-only"> — add</span>}
      </span>
      <Trailing className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </button>
  );
}

/** The calendar view's own way back to the suggestions — rendered by the caller ABOVE
 *  `ExpertAvailabilityCalendar`, never inside it (that component stays exactly as shipped). */
export function SuggestedTimesBackLink({
  onClick,
}: Readonly<{ onClick: () => void }>): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      className="text-primary mb-2 -ml-2.5"
    >
      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
      Suggested times
    </Button>
  );
}
