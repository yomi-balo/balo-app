'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { CalendarDays, CalendarCheck } from 'lucide-react';
import type { AvailabilitySlotDto, SlotDurationMinutes } from '@balo/shared/availability';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { AvailabilityMessage } from './availability-states';
import { AvailabilitySoonerOffers } from './availability-sooner-offers';
import {
  formatDayHeading,
  formatWeekdayLong,
  formatWeekdayShort,
  slotCrossesMidnight,
} from './availability-day-keys';
import type { SoonerOffer } from './availability-filters';

/**
 * The per-row reveal, budgeted rather than fixed: a flat stagger costs row-count × gap, so a
 * fully-open 32-slot day would take ~1.9s to finish appearing. Capping the whole reveal keeps a
 * short day's cadence and bounds a long one.
 */
const REVEAL_BUDGET_SECONDS = 0.45;
const MAX_ROW_STAGGER_SECONDS = 0.06;

function listVariantsFor(rowCount: number): {
  hidden: { opacity: number };
  show: { opacity: number; transition: { staggerChildren: number } };
} {
  const staggerChildren =
    rowCount > 0 ? Math.min(MAX_ROW_STAGGER_SECONDS, REVEAL_BUDGET_SECONDS / rowCount) : 0;
  return {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren } },
  };
}

const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
};

/** The slot's range at the chosen length, without the day or the " · N min" suffix (the length
 *  control above already states it). */
function SlotRange({
  start,
  length,
  viewerTimezone,
}: Readonly<{
  start: string;
  length: SlotDurationMinutes;
  viewerTimezone: string;
}>): React.JSX.Element {
  return (
    <LocalDateTime
      iso={start}
      variant="day-month-time-range"
      durationMinutes={length}
      timeZone={viewerTimezone}
      showDay={false}
      showLength={false}
    />
  );
}

export interface AvailabilitySlotsPanelProps {
  dayKey: string | null;
  isToday: boolean;
  viewerTimezone: string;
  mode: 'preview' | 'selectable';
  /** The chosen (or pinned) length. */
  length: SlotDurationMinutes;
  /** This day's ascending slots that hold `length`. */
  slotsAtLength: AvailabilitySlotDto[];
  /** Earlier, shorter alternatives. Always `[]` while the length is pinned. */
  offers: SoonerOffer[];
  /** The next day with a time at `length`, for the empty-day "Go to" action. */
  nextDayKey: string | null;
  selectedSlot: AvailabilitySlotDto | null;
  onSelectSlot: (slot: AvailabilitySlotDto) => void;
  onTakeOffer: (offer: SoonerOffer) => void;
  onGoToDay: (dayKey: string) => void;
  onConfirm: () => void;
  /** The confirm button's verb: `continue` advances a flow, `add` appends to a list. */
  confirmAction: 'continue' | 'add';
  /** Standalone confirmation (no `onSlotSelect` supplied by the consumer). */
  confirmed: boolean;
  confirmedSummary: string | null;
  /** The confirmation's own way out — the ONLY recovery when the day already selected is the
   *  one the user wants to change (a click on it reads as a deselect and is ignored). */
  onDismissConfirmation: () => void;
}

function DayHeading({
  dayKey,
  isToday,
  subline,
  hasTimes,
  headingRef,
}: Readonly<{
  dayKey: string;
  isToday: boolean;
  subline: string;
  hasTimes: boolean;
  headingRef: React.RefObject<HTMLDivElement | null>;
}>): React.JSX.Element {
  return (
    // `tabIndex={-1}` makes this programmatically focusable without entering the tab order — it
    // is where focus lands when a day is picked, so the next Tab continues from the day's list.
    <div className="mb-4 focus-visible:outline-none" ref={headingRef} tabIndex={-1}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground text-[15px] font-semibold tracking-tight">
          {formatDayHeading(dayKey)}
        </span>
        {isToday && (
          <span className="bg-primary/10 text-primary border-primary/20 rounded-md border px-2 py-0.5 text-[11px] font-semibold">
            Today
          </span>
        )}
      </div>
      <p
        aria-live="polite"
        className={
          hasTimes
            ? 'text-muted-foreground mt-1 text-[13px]'
            : 'text-foreground mt-1.5 text-sm font-medium'
        }
      >
        {subline}
      </p>
    </div>
  );
}

function SlotList({
  dayKey,
  length,
  slots,
  selectedSlot,
  mode,
  viewerTimezone,
  onSelectSlot,
}: Readonly<{
  dayKey: string;
  length: SlotDurationMinutes;
  slots: AvailabilitySlotDto[];
  selectedSlot: AvailabilitySlotDto | null;
  mode: 'preview' | 'selectable';
  viewerTimezone: string;
  onSelectSlot: (slot: AvailabilitySlotDto) => void;
}>): React.JSX.Element {
  return (
    <ScrollArea className="max-h-none md:max-h-[340px]">
      {/*
        ⚠ The `key` is load-bearing. `staggerChildren` propagates only when the PARENT
        transitions between variants, and this `motion.ul` keeps its place in the tree across a
        day or length change — only its children are replaced. Without a remount the parent
        stays on `show`, never transitions again, and the new rows sit at `initial="hidden"`
        forever.
      */}
      <motion.ul
        key={`${dayKey}:${length}`}
        variants={listVariantsFor(slots.length)}
        initial="hidden"
        animate="show"
        className="flex flex-col gap-1.5"
      >
        {slots.map((slot) => {
          const isSelected = selectedSlot?.start === slot.start;
          const end = new Date(Date.parse(slot.start) + length * 60_000).toISOString();
          // ⚠ D10 — a cross-midnight interval groups under its START day and must say so:
          // `11:45 pm – 12:45 am` alone silently means "finishes tomorrow".
          const crossesMidnight = slotCrossesMidnight({ start: slot.start, end }, viewerTimezone);
          const content = (
            <>
              <span className="text-sm font-medium">
                <SlotRange start={slot.start} length={length} viewerTimezone={viewerTimezone} />
              </span>
              {crossesMidnight && (
                <span
                  className={
                    isSelected
                      ? 'text-primary-foreground/80 text-xs'
                      : 'text-muted-foreground text-xs'
                  }
                >
                  → {formatWeekdayShort(end, viewerTimezone)}
                </span>
              )}
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
  );
}

export function AvailabilitySlotsPanel({
  dayKey,
  isToday,
  viewerTimezone,
  mode,
  length,
  slotsAtLength,
  offers,
  nextDayKey,
  selectedSlot,
  onSelectSlot,
  onTakeOffer,
  onGoToDay,
  onConfirm,
  confirmAction,
  confirmed,
  confirmedSummary,
  onDismissConfirmation,
}: Readonly<AvailabilitySlotsPanelProps>): React.JSX.Element {
  // Focus follows the day: nothing fires on first mount (`dayKey` is null until a day is
  // chosen), so the panel never steals focus from the page it was dropped into.
  const headingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (dayKey === null || confirmed) return;
    headingRef.current?.focus();
  }, [dayKey, confirmed]);

  // After a sooner offer is taken the offer buttons unmount; focus the newly pressed time row
  // (the day heading when no row is pressed, e.g. in preview), so it never drops to <body>.
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingOfferFocusRef = useRef<string | null>(null);
  const selectedStartForFocus = selectedSlot?.start;
  useEffect(() => {
    const pending = pendingOfferFocusRef.current;
    if (pending === null) return;
    pendingOfferFocusRef.current = null;
    const row = panelRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    (row ?? headingRef.current)?.focus();
  }, [length, selectedStartForFocus, slotsAtLength]);
  const handleTakeOffer = useCallback(
    (offer: SoonerOffer): void => {
      pendingOfferFocusRef.current = offer.start;
      onTakeOffer(offer);
    },
    [onTakeOffer]
  );

  // ⚠ Continue is single-shot: `onConfirm` is documented as "emits, never books", so the natural
  // parent wires it to a network call and a rapid double click must not fire two attempts. Reset
  // when the selection or length changes.
  const [submitting, setSubmitting] = useState(false);
  const selectedStart = selectedSlot?.start;
  useEffect(() => {
    setSubmitting(false);
  }, [selectedStart, length]);
  const handleContinue = useCallback((): void => {
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
        body={`Days with a dot have ${length}-minute times.`}
      />
    );
  }

  const hasTimes = slotsAtLength.length > 0;
  const weekday = formatWeekdayLong(dayKey);
  const timesWord = slotsAtLength.length === 1 ? 'time' : 'times';
  const subline = hasTimes
    ? `${slotsAtLength.length} ${timesWord} available`
    : `No ${length}-minute times on ${weekday}.`;

  return (
    <div ref={panelRef}>
      <DayHeading
        dayKey={dayKey}
        isToday={isToday}
        subline={subline}
        hasTimes={hasTimes}
        headingRef={headingRef}
      />

      {offers.length > 0 && (
        <AvailabilitySoonerOffers
          offers={offers}
          viewerTimezone={viewerTimezone}
          emptyDay={!hasTimes}
          weekday={weekday}
          onTakeOffer={handleTakeOffer}
        />
      )}

      {hasTimes && (
        <SlotList
          dayKey={dayKey}
          length={length}
          slots={slotsAtLength}
          selectedSlot={selectedSlot}
          mode={mode}
          viewerTimezone={viewerTimezone}
          onSelectSlot={onSelectSlot}
        />
      )}

      {!hasTimes && nextDayKey && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => onGoToDay(nextDayKey)}
        >
          Go to {formatDayHeading(nextDayKey)}
        </Button>
      )}

      {mode === 'selectable' && selectedSlot && (
        // Sticky bottom bar on small screens so Continue is reachable from anywhere in a long
        // list; inline from md up.
        <div className="bg-card sticky bottom-0 -mx-6 border-t px-6 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-6px_16px_rgba(16,24,40,0.06)] md:static md:mx-0 md:mt-3.5 md:border-0 md:p-0 md:shadow-none">
          <Button type="button" className="w-full" disabled={submitting} onClick={handleContinue}>
            {/* One inline run, so the Button's flex gap doesn't double the word spacing. */}
            <span>
              {confirmAction === 'add' ? 'Add' : 'Continue with'}{' '}
              <SlotRange
                start={selectedSlot.start}
                length={length}
                viewerTimezone={viewerTimezone}
              />
              {confirmAction === 'continue' && ' →'}
            </span>
          </Button>
        </div>
      )}
    </div>
  );
}
