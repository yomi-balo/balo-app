'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, CalendarDays, CalendarCheck } from 'lucide-react';
import type { AvailabilitySlotDto, SlotDurationMinutes } from '@balo/shared/availability';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AvailabilityMessage } from './availability-states';
import {
  formatDayHeading,
  formatSlotTime,
  formatWeekdayShort,
  slotCrossesMidnight,
} from './availability-day-keys';
import {
  confirmationDurations,
  derivePills,
  filterSlotsByDuration,
  type DurationFilter,
} from './availability-filters';

const listVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
} as const;

const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
};

/** Extracted so the three states stay flat — a nested ternary trips SonarCloud. */
function confirmButtonLabel(
  chosenDuration: SlotDurationMinutes | null,
  submitting: boolean
): string {
  if (submitting) return 'Confirming…';
  if (chosenDuration) return `Confirm ${chosenDuration}-min consultation`;
  return 'Select a duration above';
}

export interface AvailabilitySlotsPanelProps {
  dayKey: string | null;
  isToday: boolean;
  /** This day's full (unfiltered), ascending slot list. */
  slotsForDay: AvailabilitySlotDto[];
  viewerTimezone: string;
  mode: 'preview' | 'selectable';
  durationFilter: DurationFilter;
  /** True for the render right after a day-change auto-reset — drives the inline warning. */
  filterAutoReset: boolean;
  onFilterChange: (filter: DurationFilter) => void;
  selectedSlot: AvailabilitySlotDto | null;
  onSelectSlot: (slot: AvailabilitySlotDto) => void;
  confirmStep: boolean;
  onContinue: () => void;
  onBack: () => void;
  chosenDuration: SlotDurationMinutes | null;
  onChooseDuration: (duration: SlotDurationMinutes) => void;
  onConfirm: () => void;
  /** Standalone confirmation (no `onSlotSelect` supplied by the consumer). */
  confirmed: boolean;
  confirmedSummary: string | null;
  /** The confirmation's own way out — the ONLY recovery when the day already selected is the
   *  one the user wants to change (a click on it reads as a deselect and is ignored). */
  onDismissConfirmation: () => void;
}

export function AvailabilitySlotsPanel({
  dayKey,
  isToday,
  slotsForDay,
  viewerTimezone,
  mode,
  durationFilter,
  filterAutoReset,
  onFilterChange,
  selectedSlot,
  onSelectSlot,
  confirmStep,
  onContinue,
  onBack,
  chosenDuration,
  onChooseDuration,
  onConfirm,
  confirmed,
  confirmedSummary,
  onDismissConfirmation,
}: Readonly<AvailabilitySlotsPanelProps>): React.JSX.Element {
  /**
   * ⚠ FOCUS FOLLOWS THE STEP. This is a progressive-disclosure wizard: the element the user just
   * activated ("Continue with 9:00 AM →", "← Back", a day cell) UNMOUNTS on the next render, so
   * without this focus silently falls back to `<body>` and a keyboard or screen-reader user
   * loses their place at every single transition — the opposite of what progressive disclosure
   * is meant to buy. Nothing fires on first mount: `dayKey` is null until a day is chosen, so
   * the component never steals focus from the page it was dropped into.
   */
  const backRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (dayKey === null || confirmed) return;
    if (confirmStep) backRef.current?.focus();
    else headingRef.current?.focus();
  }, [confirmStep, dayKey, confirmed]);

  /**
   * ⚠ THE CONFIRM BUTTON IS SINGLE-SHOT. `onConfirm` is documented as "emits, never books", so
   * the natural parent wires it to a network call — and nothing here stopped a rapid double
   * click (or a slow parent) from firing two booking/hold attempts with no feedback in between.
   * Reset whenever the confirm step is left, so Back → Continue is usable again.
   */
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (!confirmStep) setSubmitting(false);
  }, [confirmStep]);
  const handleConfirmClick = useCallback((): void => {
    if (submitting) return;
    setSubmitting(true);
    onConfirm();
  }, [submitting, onConfirm]);

  if (confirmed) {
    return (
      <AvailabilityMessage
        // ⚠ NOT a success tick. Nothing was booked — see `handleConfirm`'s copy note. A green
        // check circle here reads as a completed consultation that does not exist.
        icon={<CalendarCheck className="h-5 w-5" aria-hidden="true" />}
        title={confirmedSummary ?? 'Time selected.'}
        body="Nothing is booked yet — this picker only chooses a time."
        actionLabel="Choose another time"
        onAction={onDismissConfirmation}
      />
    );
  }

  if (!dayKey) {
    return (
      <AvailabilityMessage
        icon={<CalendarDays className="h-5 w-5" aria-hidden="true" />}
        title="Select a date"
        body="Tap a highlighted day to see available times."
      />
    );
  }

  if (confirmStep && selectedSlot) {
    const durations = confirmationDurations(selectedSlot.maxDuration);
    const headDate = isToday ? 'Today' : formatDayHeading(dayKey);
    return (
      <div>
        <button
          ref={backRef}
          type="button"
          onClick={onBack}
          className="text-primary mb-4 flex min-h-11 items-center gap-1.5 text-[13px] font-medium"
        >
          ← Back
        </button>

        <div className="border-primary/30 bg-primary/5 mb-5 rounded-lg border px-4 py-3">
          <span className="text-primary text-base font-semibold">
            {formatSlotTime(selectedSlot.start, viewerTimezone)}
          </span>
          <span className="text-muted-foreground ml-2 text-[13px]">{headDate}</span>
        </div>

        <fieldset>
          <legend className="text-muted-foreground mb-2.5 text-[11px] font-semibold tracking-wider uppercase">
            How long do you need?
          </legend>
          <div className="mb-5 flex flex-col gap-1.5">
            {durations.map((d) => {
              const id = `availability-duration-${d}`;
              const isChosen = chosenDuration === d;
              const end = new Date(
                new Date(selectedSlot.start).getTime() + d * 60_000
              ).toISOString();
              return (
                <label
                  key={d}
                  htmlFor={id}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-2.5 text-left transition-colors ${
                    isChosen ? 'border-primary bg-primary/5' : 'border-border bg-card'
                  }`}
                >
                  <input
                    type="radio"
                    id={id}
                    name="availability-duration"
                    className="text-primary h-4 w-4"
                    checked={isChosen}
                    onChange={() => onChooseDuration(d)}
                  />
                  <span className="flex flex-col">
                    <span
                      className={`text-sm ${isChosen ? 'text-primary font-semibold' : 'text-foreground font-medium'}`}
                    >
                      {d} minutes
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {formatSlotTime(selectedSlot.start, viewerTimezone)} –{' '}
                      {formatSlotTime(end, viewerTimezone)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <Button
          type="button"
          className="w-full"
          disabled={!chosenDuration || submitting}
          onClick={handleConfirmClick}
        >
          {confirmButtonLabel(chosenDuration, submitting)}
        </Button>
      </div>
    );
  }

  const pills = derivePills(slotsForDay);
  // Effective filter for the LIST: 'any' whenever the day-change auto-reset fired, even though
  // `durationFilter` itself keeps the user's original choice (needed for the warning copy).
  const effectiveFilter: DurationFilter = filterAutoReset ? 'any' : durationFilter;
  const showing = filterSlotsByDuration(slotsForDay, effectiveFilter);
  const headDate = isToday ? 'Today' : formatDayHeading(dayKey);
  // Positive form deliberately: the duration label is redundant once the list is already filtered
  // to a minimum duration. (`unicorn/no-negated-condition` — a negated flag reads backwards.)
  const showDurationLabel = effectiveFilter === 'any';

  return (
    <div>
      {/* `tabIndex={-1}` makes this programmatically focusable without entering the tab order —
          it is where focus lands when a day is picked, so the next Tab continues from the day's
          slot list rather than restarting at the top of the page. */}
      <div className="mb-4" ref={headingRef} tabIndex={-1}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground text-[15px] font-semibold tracking-tight">
            {headDate}
          </span>
          {isToday && (
            <span className="bg-primary/10 text-primary border-primary/20 rounded-md border px-2 py-0.5 text-[11px] font-semibold">
              Today
            </span>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {showing.length} time{showing.length === 1 ? '' : 's'} available
          {showDurationLabel ? '' : ` for ${effectiveFilter}+ min`}
        </p>
      </div>

      <div className="mb-4">
        <p className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-wider uppercase">
          Duration
        </p>
        <div className="flex flex-wrap gap-1.5">
          {pills.map((pill) => {
            const isActive = effectiveFilter === pill;
            return (
              <Button
                key={pill}
                type="button"
                size="sm"
                variant={isActive ? 'default' : 'outline'}
                aria-pressed={isActive}
                // ⚠ 44px minimum. These pills are the primary narrowing control on a 375px
                // viewport and they wrap to two lines by design; at the previous `h-7` (28px)
                // they were the only sub-target in the panel — the slot rows beside them
                // already use `min-h-11`.
                className="h-auto min-h-11 rounded-full px-4 text-xs"
                onClick={() => onFilterChange(pill)}
              >
                {pill === 'any' ? 'Any' : `${pill} min`}
              </Button>
            );
          })}
        </div>
        {filterAutoReset && (
          <output className="text-warning mt-2 flex items-center gap-1.5 text-xs">
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
            {/* `durationFilter` is never `'any'` here: `filterAutoReset` is only set when
                `shouldResetFilter` returned true, which requires a non-`'any'` filter. The old
                ternary was an unreachable branch costing branch coverage for nothing. */}
            No {durationFilter}-min slots that day.
            <button
              type="button"
              onClick={() => onFilterChange('any')}
              className="text-primary font-semibold"
            >
              Show all →
            </button>
          </output>
        )}
      </div>

      {/* Unbounded on mobile (the page scrolls anyway); capped on DESKTOP, where the two-column
          layout is the thing that needs the list not to outgrow the calendar beside it. */}
      <ScrollArea className="max-h-none md:max-h-[340px]">
        <motion.ul
          variants={listVariants}
          initial="hidden"
          animate="show"
          className="flex flex-col gap-1.5"
        >
          {showing.map((slot) => {
            const isSelected = selectedSlot?.start === slot.start;
            const secondaryClass = isSelected
              ? 'text-primary-foreground/80 text-xs'
              : 'text-muted-foreground text-xs';
            // ⚠ D10 — cross-midnight intervals group under their START day, "labelled to show
            // the crossing". `11:45 PM · up to 60m` otherwise silently means "finishes
            // tomorrow". This row is the ONLY place `preview` mode can show it: preview has no
            // duration step, where the explicit end time would eventually have revealed it.
            const crossesMidnight = slotCrossesMidnight(slot, viewerTimezone);
            const content = (
              <>
                <span className="text-sm font-medium">
                  {formatSlotTime(slot.start, viewerTimezone)}
                </span>
                <span className="flex items-center gap-1.5">
                  {crossesMidnight && (
                    <span className={secondaryClass}>
                      → {formatWeekdayShort(slot.end, viewerTimezone)}
                    </span>
                  )}
                  {showDurationLabel && (
                    <span className={secondaryClass}>up to {slot.maxDuration}m</span>
                  )}
                </span>
              </>
            );
            return (
              <motion.li key={slot.start} variants={rowVariants}>
                {mode === 'selectable' ? (
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => onSelectSlot(slot)}
                    className={`border-border flex min-h-11 w-full items-center justify-between rounded-lg border px-3.5 py-2 transition-colors ${
                      isSelected
                        ? 'bg-primary text-primary-foreground border-transparent'
                        : 'hover:border-primary hover:bg-primary/5 bg-card'
                    }`}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="border-border bg-card flex min-h-11 w-full items-center justify-between rounded-lg border px-3.5 py-2">
                    {content}
                  </div>
                )}
              </motion.li>
            );
          })}
        </motion.ul>
      </ScrollArea>

      {mode === 'selectable' && selectedSlot && (
        <Button type="button" className="mt-3.5 w-full" onClick={onContinue}>
          Continue with {formatSlotTime(selectedSlot.start, viewerTimezone)} →
        </Button>
      )}
    </div>
  );
}
