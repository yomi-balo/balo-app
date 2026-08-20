'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CalendarX, Clock, Globe, RefreshCw } from 'lucide-react';
import type { AvailabilitySlotDto, SlotDurationMinutes } from '@balo/shared/availability';
import {
  DEFAULT_AVAILABILITY_WINDOW_DAYS,
  MAX_AVAILABILITY_WINDOW_DAYS,
} from '@balo/shared/availability';
import { isValidTimezone } from '@balo/shared/timezone';
import { track, AVAILABILITY_EVENTS } from '@/lib/analytics';
import { useExpertAvailability, type AvailabilityView } from './use-expert-availability';
import { AvailabilityMessage, AvailabilitySkeleton } from './availability-states';
import { AvailabilityMonthCalendar } from './availability-month-calendar';
import { AvailabilitySlotsPanel } from './availability-slots-panel';
import {
  formatDayHeading,
  formatSlotTime,
  formatTimezoneLabel,
  groupSlotsByDay,
  slotDayKey,
  todayDayKey,
} from './availability-day-keys';
import { shouldResetFilter, type DurationFilter } from './availability-filters';

export interface AvailabilitySlotSelection {
  /** UTC ISO-8601 instant. */
  start: string;
  /** UTC ISO-8601 instant = `start` + `duration` minutes. */
  end: string;
  /** Minutes. Always ∈ `SLOT_DURATION_LADDER`. */
  duration: SlotDurationMinutes;
}

export interface ExpertAvailabilityCalendarProps {
  /** `expert_profiles.id`. */
  expertProfileId: string;
  /** `'preview'` = read-only, non-interactive rows (D9). Default `'selectable'`. */
  mode?: 'preview' | 'selectable';
  /** IANA zone slots are RENDERED in. Defaults to the browser's zone. */
  viewerTimezone?: string;
  /**
   * Look-ahead in days. Defaults to `DEFAULT_AVAILABILITY_WINDOW_DAYS` (14).
   *
   * ⚠ The server REJECTS a value above `MAX_AVAILABILITY_WINDOW_DAYS` with a 400 — it does not
   * silently clamp — so this component clamps into range before asking. A consumer that trusts
   * an out-of-range value would otherwise get the generic "Couldn't load availability." with no
   * clue why. Read only at mount; later changes to this prop are ignored (see `days` state).
   */
  daysAhead?: number;
  /** Selectable only. Called with the final selection. The component NEVER books. */
  onSlotSelect?: (selection: AvailabilitySlotSelection) => void;
  /** Analytics only — which side is looking. Default `'client'`. */
  viewerType?: 'expert' | 'client';
  /** Optional CTA rendered inside the `not_configured` / `no availability` states. */
  emptyAction?: ReactNode;
  className?: string;
}

/**
 * Which `availability_empty_state_shown` reason a view kind reports, or `null` for the kinds
 * that are not empty states. A lookup, not a ternary chain (SonarCloud bans nested conditionals,
 * and the chain was the single biggest contributor to this component's cognitive complexity).
 */
type EmptyStateReason = 'not_configured' | 'no_slots' | 'unavailable';

const EMPTY_STATE_REASONS: Partial<Record<AvailabilityView['kind'], EmptyStateReason>> = {
  not_configured: 'not_configured',
  empty_window: 'no_slots',
  unavailable: 'unavailable',
};

function emptyStateReason(kind: AvailabilityView['kind']): EmptyStateReason | null {
  return EMPTY_STATE_REASONS[kind] ?? null;
}

interface AvailabilityStateMessageProps {
  /** Every kind EXCEPT `ready` and `loading`, both of which the parent renders itself. */
  view: Exclude<AvailabilityView, { kind: 'ready' } | { kind: 'loading' }>;
  mode: 'preview' | 'selectable';
  emptyAction?: ReactNode;
  onRetry: () => void;
  onWiden: () => void;
}

/**
 * Every non-content state, in one place. Extracted from the parent so the calendar component
 * stays under SonarCloud's cognitive-complexity ceiling — five early returns for five states was
 * the bulk of its branching, and none of it touches selection state.
 */
function AvailabilityStateMessage({
  view,
  mode,
  emptyAction,
  onRetry,
  onWiden,
}: Readonly<AvailabilityStateMessageProps>): React.JSX.Element {
  /**
   * ⚠ ONLY THE EXPERT'S OWN PREVIEW LEARNS THAT THE PROFILE EXISTS BUT IS UNPUBLISHED. The
   * server answers a byte-identical 404 for "not approved", "not searchable" and "no such uuid"
   * precisely so an anonymous caller cannot tell them apart; a "Not published yet" panel in
   * `selectable` mode would hand that distinction straight back. Anyone but the owner falls
   * through to the generic error state (plan §5/§6).
   */
  if (view.kind === 'not_published' && mode === 'preview') {
    return (
      <AvailabilityMessage
        icon={<CalendarX className="h-5 w-5" aria-hidden="true" />}
        title="Not published yet"
        body="Your profile isn't published yet — once it's live, clients will see these times here."
        action={emptyAction}
      />
    );
  }

  if (view.kind === 'error' || view.kind === 'not_published') {
    return (
      <AvailabilityMessage
        tone="destructive"
        icon={<AlertTriangle className="h-5 w-5" aria-hidden="true" />}
        title="Couldn't load availability."
        actionLabel="Try again"
        onAction={onRetry}
      />
    );
  }

  if (view.kind === 'unavailable') {
    return (
      <AvailabilityMessage
        tone="warning"
        icon={<RefreshCw className="h-5 w-5" aria-hidden="true" />}
        title="We can't reach their calendar right now"
        body="So we can't show times. This is usually brief."
        actionLabel="Try again"
        onAction={onRetry}
      />
    );
  }

  if (view.kind === 'not_configured') {
    return (
      <AvailabilityMessage
        icon={<Clock className="h-5 w-5" aria-hidden="true" />}
        title={mode === 'preview' ? "Hours aren't set yet" : "Booking hours aren't published yet"}
        body={
          mode === 'preview'
            ? 'Add your hours above and clients will see bookable times here.'
            : "Send a request and they'll come back to you with times."
        }
        action={emptyAction}
      />
    );
  }

  // ⚠ LEAD WITH THE ACTION, not the absence (`balo-ui-skill`'s empty-state rule) — but only when
  // there IS an action. At the maximum window there is nothing further to offer, so inviting the
  // user to look further ahead would be a dead promise; state it plainly instead.
  const canWiden = view.days < MAX_AVAILABILITY_WINDOW_DAYS;
  return (
    <AvailabilityMessage
      icon={<CalendarX className="h-5 w-5" aria-hidden="true" />}
      title={
        canWiden
          ? `Look further ahead — nothing open in the next ${view.days} days yet.`
          : `Nothing open in the next ${view.days} days. Send a request and they'll come back to you with times.`
      }
      actionLabel={canWiden ? 'Look further ahead' : undefined}
      onAction={canWiden ? onWiden : undefined}
      action={emptyAction}
    />
  );
}

export function ExpertAvailabilityCalendar({
  expertProfileId,
  mode = 'selectable',
  viewerTimezone,
  daysAhead,
  onSlotSelect,
  viewerType = 'client',
  emptyAction,
  className,
}: Readonly<ExpertAvailabilityCalendarProps>): React.JSX.Element {
  const [resolvedTimezone, setResolvedTimezone] = useState<string | null>(
    viewerTimezone && isValidTimezone(viewerTimezone) ? viewerTimezone : null
  );
  // Resolved in an effect, not at first render: `Intl…resolvedOptions().timeZone` is a browser
  // value and would differ between the server render and hydration.
  useEffect(() => {
    setResolvedTimezone(
      viewerTimezone && isValidTimezone(viewerTimezone)
        ? viewerTimezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone
    );
  }, [viewerTimezone]);

  // Clamped HERE because the server rejects out-of-range values rather than clamping them.
  const defaultDays = Math.min(
    Math.max(1, daysAhead ?? DEFAULT_AVAILABILITY_WINDOW_DAYS),
    MAX_AVAILABILITY_WINDOW_DAYS
  );
  const [days, setDays] = useState(defaultDays);

  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);
  const [durationFilter, setDurationFilter] = useState<DurationFilter>('any');
  const [filterAutoReset, setFilterAutoReset] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlotDto | null>(null);
  const [confirmStep, setConfirmStep] = useState(false);
  const [chosenDuration, setChosenDuration] = useState<SlotDurationMinutes | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedSummary, setConfirmedSummary] = useState<string | null>(null);

  const { view, reload } = useExpertAvailability(expertProfileId, days);

  const viewedTrackedRef = useRef(false);
  useEffect(() => {
    if (view.kind !== 'loading' && !viewedTrackedRef.current) {
      viewedTrackedRef.current = true;
      track(AVAILABILITY_EVENTS.CALENDAR_VIEWED, {
        expert_id: expertProfileId,
        mode,
        viewer_type: viewerType,
      });
    }
  }, [view.kind, expertProfileId, mode, viewerType]);

  const emptyReasonTrackedRef = useRef<string | null>(null);
  useEffect(() => {
    const reason = emptyStateReason(view.kind);
    if (reason && emptyReasonTrackedRef.current !== reason) {
      emptyReasonTrackedRef.current = reason;
      track(AVAILABILITY_EVENTS.EMPTY_STATE_SHOWN, { expert_id: expertProfileId, reason });
    }
    if (!reason) {
      emptyReasonTrackedRef.current = null;
    }
  }, [view.kind, expertProfileId]);

  /**
   * ⚠ THE FALLBACK MAP IS TYPED. A bare `new Map()` widens the memo to
   * `Map<string, AvailabilitySlotDto[]> | Map<any, any>`, so `.get()` returns `any` and the slot
   * type is erased for the whole downstream pipeline — `slotsForSelectedDay` flows unchecked
   * into a `AvailabilitySlotDto[]` prop and a wire/shape regression in `groupSlotsByDay` would
   * not be caught. No `any` token appears, but it is a `no any` breach in substance.
   */
  const slotsByDay = useMemo(
    () =>
      view.kind === 'ready' && resolvedTimezone
        ? groupSlotsByDay(view.slots, resolvedTimezone)
        : new Map<string, AvailabilitySlotDto[]>(),
    [view, resolvedTimezone]
  );
  const daysWithSlots = useMemo(() => new Set(slotsByDay.keys()), [slotsByDay]);
  const slotsForSelectedDay: AvailabilitySlotDto[] = selectedDayKey
    ? (slotsByDay.get(selectedDayKey) ?? [])
    : [];

  /**
   * ⚠ SELECTION IS PER-EXPERT. Without this, swapping `expertProfileId` keeps the previous
   * expert's day/slot/duration selected while `track(SLOT_SELECTED, …)` reports the NEW expert —
   * the caller would book expert B at a time only expert A advertised. Latent while the only
   * shipped consumer is a fixed-id preview, but this is an exported reusable component and a
   * documented `key=` convention at call sites is not a control.
   */
  const knownExpertRef = useRef(expertProfileId);
  useEffect(() => {
    if (knownExpertRef.current === expertProfileId) return;
    knownExpertRef.current = expertProfileId;
    setSelectedDayKey(null);
    setSelectedSlot(null);
    setConfirmStep(false);
    setChosenDuration(null);
    setDurationFilter('any');
    setFilterAutoReset(false);
    setConfirmed(false);
    setConfirmedSummary(null);
  }, [expertProfileId]);

  /**
   * ⚠ `confirmed` MUST BE PART OF EVERY RESET. It short-circuits the whole right-hand panel
   * while the month calendar stays fully interactive behind it — so leaving it set turned a day
   * click into a no-op and stranded the user in an unrecoverable dead end for the rest of the
   * component's life. Note a click on the ALREADY-selected day cannot recover on its own
   * (react-day-picker reports a deselect, which this component ignores), which is why the
   * confirmation panel also carries its own "Choose another time" action wired to this.
   */
  function resetSelection(): void {
    setSelectedSlot(null);
    setConfirmStep(false);
    setChosenDuration(null);
    setConfirmed(false);
    setConfirmedSummary(null);
  }

  function handleSelectDayKey(dayKey: string): void {
    setSelectedDayKey(dayKey);
    resetSelection();
    const daySlots = slotsByDay.get(dayKey) ?? [];
    // ⚠ `durationFilter` itself is NOT reset here — it stays the user's last explicit choice so
    // the warning copy can still name it, and the panel derives the EFFECTIVE ('any') filter
    // for the shown list from `filterAutoReset` alone. Pure predicate, no effect (D13).
    if (shouldResetFilter(daySlots, durationFilter)) {
      setFilterAutoReset(true);
      track(AVAILABILITY_EVENTS.EMPTY_STATE_SHOWN, {
        expert_id: expertProfileId,
        reason: 'no_slots_for_filter',
      });
    } else {
      setFilterAutoReset(false);
    }
  }

  function handleFilterChange(filter: DurationFilter): void {
    setDurationFilter(filter);
    setFilterAutoReset(false);
    resetSelection();
    track(AVAILABILITY_EVENTS.DURATION_FILTER_USED, {
      expert_id: expertProfileId,
      filter_value: filter,
    });
  }

  function handleConfirm(): void {
    if (!selectedSlot || !chosenDuration || !resolvedTimezone) return;
    // ⚠ RE-VERIFY MEMBERSHIP, do not trust the render that produced the button. If the parent
    // swaps `expertProfileId` mid-flow, the panel re-renders the PREVIOUS expert's slot; emitting
    // it would hand the caller a time the new expert never advertised. The reset effect below
    // clears this state, but this guard does not depend on the effect having run first.
    if (!slotsForSelectedDay.some((s) => s.start === selectedSlot.start)) return;
    const start = selectedSlot.start;
    const end = new Date(new Date(start).getTime() + chosenDuration * 60_000).toISOString();
    const selection: AvailabilitySlotSelection = { start, end, duration: chosenDuration };

    track(AVAILABILITY_EVENTS.SLOT_SELECTED, {
      expert_id: expertProfileId,
      slot_start_utc: start,
      duration_minutes: chosenDuration,
      viewer_timezone: resolvedTimezone,
    });

    if (onSlotSelect) {
      onSlotSelect(selection);
      return;
    }
    // ⚠ THIS COMPONENT NEVER BOOKS. With no `onSlotSelect` wired there is no downstream step at
    // all, so the copy states what was SELECTED and names the time — a green tick over
    // "Nice — Wednesday 26 August for 60 minutes." reads as a completed booking of a
    // consultation that does not exist, and omitting the time makes two confirmations on a
    // twelve-slot day indistinguishable.
    const day = selectedDayKey ? formatDayHeading(selectedDayKey) : '';
    const time = formatSlotTime(start, resolvedTimezone);
    setConfirmedSummary(`Time selected: ${day} at ${time}, ${chosenDuration} minutes.`);
    setConfirmed(true);
  }

  if (!resolvedTimezone || view.kind === 'loading') {
    return (
      <div className={className}>
        <AvailabilitySkeleton />
      </div>
    );
  }

  if (view.kind !== 'ready') {
    return (
      <div className={className}>
        <AvailabilityStateMessage
          view={view}
          mode={mode}
          emptyAction={emptyAction}
          onRetry={reload}
          onWiden={() => setDays(MAX_AVAILABILITY_WINDOW_DAYS)}
        />
      </div>
    );
  }

  // view.kind === 'ready'
  const now = new Date();
  const windowEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const todayKey = todayDayKey(resolvedTimezone, now);

  return (
    <div className={className}>
      <div className="text-muted-foreground mb-3 flex items-center gap-1.5 px-0.5 text-xs">
        <Globe className="h-3 w-3" aria-hidden="true" />
        <span>{formatTimezoneLabel(resolvedTimezone, now)}</span>
      </div>

      <div className="bg-border grid grid-cols-1 gap-px overflow-hidden rounded-xl border md:grid-cols-[minmax(0,1fr)_300px]">
        <div className="bg-card p-6">
          <AvailabilityMonthCalendar
            selectedDayKey={selectedDayKey}
            onSelectDayKey={handleSelectDayKey}
            daysWithSlots={daysWithSlots}
            viewerTodayKey={todayKey}
            viewerWindowEndKey={slotDayKey(windowEnd.toISOString(), resolvedTimezone)}
          />
        </div>
        <div className="bg-card min-w-0 p-6">
          <AvailabilitySlotsPanel
            dayKey={selectedDayKey}
            isToday={selectedDayKey === todayKey}
            slotsForDay={slotsForSelectedDay}
            viewerTimezone={resolvedTimezone}
            mode={mode}
            durationFilter={durationFilter}
            filterAutoReset={filterAutoReset}
            onFilterChange={handleFilterChange}
            selectedSlot={selectedSlot}
            onSelectSlot={setSelectedSlot}
            confirmStep={confirmStep}
            onContinue={() => setConfirmStep(true)}
            onBack={() => {
              setConfirmStep(false);
              setChosenDuration(null);
            }}
            chosenDuration={chosenDuration}
            onChooseDuration={setChosenDuration}
            onConfirm={handleConfirm}
            confirmed={confirmed}
            confirmedSummary={confirmedSummary}
            onDismissConfirmation={resetSelection}
          />
        </div>
      </div>
    </div>
  );
}
