'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, CalendarX, Clock, Globe, Pause, RefreshCw } from 'lucide-react';
import type {
  AvailabilityScope,
  AvailabilitySlotDto,
  SlotDurationMinutes,
} from '@balo/shared/availability';
import { EXPERT_CALENDAR_SETTINGS_PATH } from '@balo/shared/calendar';
import { Button } from '@/components/ui/button';
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
import { LengthControl } from './availability-length-control';
import { useNowTick } from './use-now-tick';
import {
  formatDayHeading,
  formatSlotTime,
  formatTimezoneLabel,
  groupSlotsByDay,
  slotDayKey,
  todayDayKey,
} from './availability-day-keys';
import {
  availableLengths,
  dropPastSlots,
  fallbackLength,
  fitsLength,
  nextDayAtLength,
  soonerOffers,
  splitDaysByLength,
  type SoonerOffer,
} from './availability-filters';

export interface AvailabilitySlotSelection {
  /** UTC ISO-8601 instant. */
  start: string;
  /** UTC ISO-8601 instant = `start` + `duration` minutes. */
  end: string;
  /** Minutes. Always ∈ `SLOT_DURATION_LADDER`. */
  duration: SlotDurationMinutes;
}

export interface ExpertAvailabilityCalendarProps {
  /**
   * The caller (the expert's own settings) already knows the profile is not publicly visible:
   * resolve straight to the `not_published` state without calling the public endpoint.
   */
  skipFetch?: boolean;
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
  /**
   * BAL-409 — pin the length to a MEETING's existing length (a reschedule MOVES a booking, it
   * does not resize it): the length control is replaced by a read-only line, and there are no
   * shorter-call offers or rings. This is a UI AFFORDANCE ONLY — the server still pins the
   * length regardless of what the picker returns, so this prop never enforces anything by
   * itself; it exists so a client cannot pick a 30-minute slot for a 60-minute meeting and be
   * met with a confusing `409`. Omit it (the default) for the free length choice.
   */
  fixedDurationMinutes?: SlotDurationMinutes;
  /** The length preselected when nothing else decides it. Default 60; stepped down the ladder
   *  to the longest length some time can hold. Ignored when pinned. */
  defaultDurationMinutes?: SlotDurationMinutes;
  /** Restores a previous choice after "Change": its length and day, and its time if that time
   *  is still offered at that length. */
  initialSelection?: AvailabilitySlotSelection;
  /** Billing copy under the length control. Never rendered while the length is pinned. */
  lengthNote?: ReactNode;
  /** Selectable only. Called with the final selection. The component NEVER books. */
  onSlotSelect?: (selection: AvailabilitySlotSelection) => void;
  /** Analytics only — which side is looking. Default `'client'`. */
  viewerType?: 'expert' | 'client';
  /** Optional CTA rendered inside the `not_configured` / `no availability` states. */
  emptyAction?: ReactNode;
  /** Replaces `emptyAction` on the paused state only (a "Find a similar expert" link). */
  pausedAction?: ReactNode;
  /**
   * Which kind of work the grid is read for. Default `new_work`: a paused expert shows the
   * paused panel instead of slots. Pass `existing_work` for pickers that serve work already in
   * flight (intro calls, reschedules, follow-ups on an open case).
   */
  scope?: AvailabilityScope;
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
  /** Fix round 1 item 15 — the OWNER is entitled to the `not_published` distinction even in
   *  `selectable` mode (see the panel's own comment below). */
  viewerType: 'expert' | 'client';
  emptyAction?: ReactNode;
  pausedAction?: ReactNode;
  onRetry: () => void;
  onWiden: () => void;
}

/**
 * Fix round — the `not_published && viewerType === 'expert'` arm, extracted out of
 * `AvailabilityStateMessage` to keep THAT function's own cognitive complexity under the
 * ceiling once this arm (Fix round 1 item 15) landed alongside the other four states. See the
 * inline comment this carried at its original call site for why the concealment rule keys off
 * `viewerType`, not `mode`.
 */
function NotPublishedForExpertMessage({
  mode,
  emptyAction,
}: Readonly<{
  mode: 'preview' | 'selectable';
  emptyAction?: ReactNode;
}>): React.JSX.Element {
  return (
    <AvailabilityMessage
      icon={<CalendarX className="h-5 w-5" aria-hidden="true" />}
      title="Not published yet"
      body={
        mode === 'preview'
          ? "Your profile isn't published yet — once it's live, clients will see these times here."
          : "Your profile isn't published yet — publish your availability so clients (and this picker) can see your times."
      }
      action={
        mode === 'preview' ? (
          emptyAction
        ) : (
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link href={EXPERT_CALENDAR_SETTINGS_PATH}>Availability settings</Link>
          </Button>
        )
      }
    />
  );
}

/**
 * Every non-content state, in one place. Extracted from the parent so the calendar component
 * stays under SonarCloud's cognitive-complexity ceiling — five early returns for five states was
 * the bulk of its branching, and none of it touches selection state.
 */
function AvailabilityStateMessage({
  view,
  mode,
  viewerType,
  emptyAction,
  pausedAction,
  onRetry,
  onWiden,
}: Readonly<AvailabilityStateMessageProps>): React.JSX.Element {
  /**
   * ⚠ ONLY THE EXPERT'S OWN VIEW LEARNS THAT THE PROFILE EXISTS BUT IS UNPUBLISHED. The server
   * answers a byte-identical 404 for "not approved", "not searchable" and "no such uuid"
   * precisely so an anonymous caller cannot tell them apart; a "Not published yet" panel for a
   * CLIENT would hand that distinction straight back. Anyone but the owner falls through to the
   * generic error state (plan §5/§6).
   *
   * Fix round 1 item 15 — gated on `viewerType === 'expert'`, NOT `mode === 'preview'`. Before
   * this fix an unsearchable expert proposing their own reschedule times
   * (`propose-times-dialog.tsx`, `mode="selectable"`, `viewerType="expert"`) fell through to
   * the generic "Couldn't load availability." with a Retry that could never succeed — the ONE
   * party entitled to the "not published" distinction (the profile's own owner) was denied it
   * purely because THIS surface happens to be selectable rather than a preview. `mode` answers
   * "is this read-only", `viewerType` answers "whose profile is this" — the concealment rule is
   * about the second question, not the first.
   */
  if (view.kind === 'not_published' && viewerType === 'expert') {
    return <NotPublishedForExpertMessage mode={mode} emptyAction={emptyAction} />;
  }

  if (view.kind === 'paused') {
    return (
      <AvailabilityMessage
        paused
        icon={<Pause className="h-5 w-5" aria-hidden="true" />}
        title="Not taking on new work right now"
        body={
          mode === 'preview'
            ? 'Clients see this message instead of your times until you turn new work back on.'
            : 'You can still message them.'
        }
        action={pausedAction ?? emptyAction}
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

type StateView = Exclude<AvailabilityView, { kind: 'ready' } | { kind: 'loading' }>;

/** The view to render as a message, or `null` when the grid itself should render. */
function nonContentView(view: AvailabilityView, liveSlotCount: number): StateView | null {
  if (view.kind === 'loading') return null;
  if (view.kind !== 'ready') return view;
  return liveSlotCount === 0 ? { kind: 'empty_window', days: view.days } : null;
}

function PinnedLengthLine({
  minutes,
}: Readonly<{ minutes: SlotDurationMinutes }>): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span className="text-foreground text-sm font-medium">Length</span>
      <span className="text-foreground text-sm font-medium">
        {minutes} minutes — same as your current consultation
      </span>
    </div>
  );
}

export function ExpertAvailabilityCalendar({
  expertProfileId,
  mode = 'selectable',
  viewerTimezone,
  daysAhead,
  fixedDurationMinutes,
  defaultDurationMinutes,
  initialSelection,
  lengthNote,
  onSlotSelect,
  viewerType = 'client',
  emptyAction,
  pausedAction,
  scope,
  className,
  skipFetch,
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
  const [chosenLength, setChosenLength] = useState<SlotDurationMinutes | null>(null);
  const [selectedStart, setSelectedStart] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedSummary, setConfirmedSummary] = useState<string | null>(null);
  const lengthTouchedRef = useRef(false);

  const { view, reload } = useExpertAvailability(expertProfileId, days, scope, skipFetch);
  const now = useNowTick();
  const pinned = fixedDurationMinutes !== undefined;

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

  // Slots whose start has passed are dropped at render, on the ticking clock — a grid fetched
  // earlier must never keep offering a time that has already begun.
  const liveSlots = useMemo(
    () => (view.kind === 'ready' ? dropPastSlots(view.slots, now) : []),
    [view, now]
  );

  const liveSlotCount = liveSlots.length;
  const emptyReasonTrackedRef = useRef<string | null>(null);
  useEffect(() => {
    // A `ready` view whose slots have all started reads as an empty window, same as the server's.
    const reason =
      emptyStateReason(view.kind) ??
      (view.kind === 'ready' && liveSlotCount === 0 ? 'no_slots' : null);
    if (reason && emptyReasonTrackedRef.current !== reason) {
      emptyReasonTrackedRef.current = reason;
      track(AVAILABILITY_EVENTS.EMPTY_STATE_SHOWN, { expert_id: expertProfileId, reason });
    }
    if (!reason) {
      emptyReasonTrackedRef.current = null;
    }
  }, [view.kind, liveSlotCount, expertProfileId]);

  /**
   * ⚠ THE FALLBACK MAP IS TYPED. A bare `new Map()` widens the memo to
   * `Map<string, AvailabilitySlotDto[]> | Map<any, any>`, so `.get()` returns `any` and the slot
   * type is erased for the whole downstream pipeline.
   */
  const slotsByDay = useMemo(
    () =>
      resolvedTimezone
        ? groupSlotsByDay(liveSlots, resolvedTimezone)
        : new Map<string, AvailabilitySlotDto[]>(),
    [liveSlots, resolvedTimezone]
  );
  const sortedDayKeys = useMemo(
    () => [...slotsByDay.keys()].sort((a, b) => a.localeCompare(b)),
    [slotsByDay]
  );
  const lengthsOffered = useMemo(() => availableLengths(liveSlots), [liveSlots]);

  // Derived, never set in an effect, so nothing slides on load or restore.
  const effectiveDefault = fallbackLength(
    initialSelection?.duration ?? defaultDurationMinutes ?? 60,
    liveSlots
  );
  const length: SlotDurationMinutes = fixedDurationMinutes ?? chosenLength ?? effectiveDefault;

  const { daysAtLength, daysShorterOnly } = useMemo(
    () => splitDaysByLength(slotsByDay, length, pinned),
    [slotsByDay, length, pinned]
  );
  const daySlots = useMemo(
    () => (selectedDayKey ? (slotsByDay.get(selectedDayKey) ?? []) : []),
    [slotsByDay, selectedDayKey]
  );
  const slotsAtLength = useMemo(
    () => daySlots.filter((s) => fitsLength(s, length)),
    [daySlots, length]
  );
  // A slot that has passed `now`, or no longer holds the length, deselects on render.
  const selectedSlot = slotsAtLength.find((s) => s.start === selectedStart) ?? null;
  const offers = useMemo(
    () => (pinned ? [] : soonerOffers(daySlots, length)),
    [pinned, daySlots, length]
  );
  const nextDayKey =
    selectedDayKey && slotsAtLength.length === 0
      ? nextDayAtLength(sortedDayKeys, selectedDayKey, daysAtLength)
      : null;

  const offerShownRef = useRef(new Set<string>());
  useEffect(() => {
    if (pinned || !selectedDayKey || offers.length === 0) return;
    const key = `${selectedDayKey}:${length}`;
    if (offerShownRef.current.has(key)) return;
    offerShownRef.current.add(key);
    track(AVAILABILITY_EVENTS.SOONER_OFFER_SHOWN, {
      expert_id: expertProfileId,
      chosen_minutes: length,
      offered_minutes: offers.map((o) => o.minutes),
    });
  }, [pinned, selectedDayKey, length, offers, expertProfileId]);

  const emptyAtLengthRef = useRef(new Set<string>());
  useEffect(() => {
    if (pinned || !selectedDayKey || daySlots.length === 0 || slotsAtLength.length > 0) return;
    const key = `${selectedDayKey}:${length}`;
    if (emptyAtLengthRef.current.has(key)) return;
    emptyAtLengthRef.current.add(key);
    track(AVAILABILITY_EVENTS.EMPTY_STATE_SHOWN, {
      expert_id: expertProfileId,
      reason: 'no_slots_at_length',
    });
  }, [pinned, selectedDayKey, length, daySlots, slotsAtLength, expertProfileId]);

  /**
   * ⚠ SELECTION IS PER-EXPERT. Without this, swapping `expertProfileId` keeps the previous
   * expert's day/slot/length selected while `track(SLOT_SELECTED, …)` reports the NEW expert —
   * the caller would book expert B at a time only expert A advertised. Latent while the only
   * shipped consumer is a fixed-id preview, but this is an exported reusable component and a
   * documented `key=` convention at call sites is not a control.
   */
  const knownExpertRef = useRef(expertProfileId);
  useEffect(() => {
    if (knownExpertRef.current === expertProfileId) return;
    knownExpertRef.current = expertProfileId;
    setSelectedDayKey(null);
    setSelectedStart(null);
    setChosenLength(null);
    lengthTouchedRef.current = false;
    offerShownRef.current.clear();
    emptyAtLengthRef.current.clear();
    setConfirmed(false);
    setConfirmedSummary(null);
  }, [expertProfileId]);

  // Restore once the grid is ready: the day, and the time only if it is still offered at the
  // restored length.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !initialSelection || view.kind !== 'ready' || !resolvedTimezone) {
      return;
    }
    restoredRef.current = true;
    const dayKey = slotDayKey(initialSelection.start, resolvedTimezone);
    const restoredDaySlots = slotsByDay.get(dayKey);
    if (!restoredDaySlots) return;
    setSelectedDayKey(dayKey);
    const stillOffered = restoredDaySlots.some(
      (s) => s.start === initialSelection.start && fitsLength(s, length)
    );
    if (stillOffered && length === initialSelection.duration)
      setSelectedStart(initialSelection.start);
  }, [initialSelection, view.kind, resolvedTimezone, slotsByDay, length]);

  /**
   * ⚠ `confirmed` MUST BE PART OF EVERY RESET. It short-circuits the whole right-hand panel
   * while the month calendar stays fully interactive behind it — so leaving it set turned a day
   * click into a no-op and stranded the user in an unrecoverable dead end for the rest of the
   * component's life. Note a click on the ALREADY-selected day cannot recover on its own
   * (react-day-picker reports a deselect, which this component ignores), which is why the
   * confirmation panel also carries its own "Choose another time" action wired to this.
   */
  function resetSelection(): void {
    setSelectedStart(null);
    setConfirmed(false);
    setConfirmedSummary(null);
  }

  function handleSelectDayKey(dayKey: string): void {
    setSelectedDayKey(dayKey);
    resetSelection();
  }

  function chooseLength(next: SlotDurationMinutes, source: 'pill' | 'sooner_offer'): void {
    if (next === length) return;
    // Keep the chosen time when it can hold the new length; otherwise clear it.
    if (!selectedSlot || !fitsLength(selectedSlot, next)) setSelectedStart(null);
    setConfirmed(false);
    setConfirmedSummary(null);
    setChosenLength(next);
    lengthTouchedRef.current = true;
    track(AVAILABILITY_EVENTS.DURATION_CHOSEN, {
      expert_id: expertProfileId,
      duration_minutes: next,
      previous_minutes: length,
      source,
    });
  }

  function handleTakeOffer(offer: SoonerOffer): void {
    chooseLength(offer.minutes, 'sooner_offer');
    if (mode === 'selectable') setSelectedStart(offer.start);
  }

  function handleConfirm(): void {
    if (!selectedSlot || !resolvedTimezone) return;
    // ⚠ RE-VERIFY MEMBERSHIP, do not trust the render that produced the button. If the parent
    // swaps `expertProfileId` mid-flow, the panel re-renders the PREVIOUS expert's slot; emitting
    // it would hand the caller a time the new expert never advertised. The reset effect above
    // clears this state, but this guard does not depend on the effect having run first.
    if (!daySlots.some((s) => s.start === selectedSlot.start)) return;
    const start = selectedSlot.start;
    const end = new Date(Date.parse(start) + length * 60_000).toISOString();
    const selection: AvailabilitySlotSelection = { start, end, duration: length };

    track(AVAILABILITY_EVENTS.SLOT_SELECTED, {
      expert_id: expertProfileId,
      slot_start_utc: start,
      duration_minutes: length,
      viewer_timezone: resolvedTimezone,
      duration_is_default: !pinned && !lengthTouchedRef.current && length === effectiveDefault,
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
    setConfirmedSummary(`Time selected: ${day} at ${time}, ${length} minutes.`);
    setConfirmed(true);
  }

  if (!resolvedTimezone || view.kind === 'loading') {
    return (
      <div className={className}>
        <AvailabilitySkeleton />
      </div>
    );
  }

  // `ready` with every slot already started reads as an empty window.
  const stateView = nonContentView(view, liveSlots.length);
  if (stateView) {
    return (
      <div className={className}>
        <AvailabilityStateMessage
          view={stateView}
          mode={mode}
          viewerType={viewerType}
          emptyAction={emptyAction}
          pausedAction={pausedAction}
          onRetry={reload}
          onWiden={() => setDays(MAX_AVAILABILITY_WINDOW_DAYS)}
        />
      </div>
    );
  }

  const windowEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const todayKey = todayDayKey(resolvedTimezone, now);

  return (
    <div className={className}>
      <div className="mb-3">
        {fixedDurationMinutes === undefined ? (
          <LengthControl
            value={length}
            onChange={(next) => chooseLength(next, 'pill')}
            isAvailable={(d) => lengthsOffered.has(d)}
            days={days}
          />
        ) : (
          <PinnedLengthLine minutes={fixedDurationMinutes} />
        )}
        {!pinned && lengthNote && <div className="mt-2">{lengthNote}</div>}
        <div className="text-muted-foreground mt-3 flex items-center gap-1.5 px-0.5 text-xs">
          <Globe className="h-3 w-3" aria-hidden="true" />
          <span>{formatTimezoneLabel(resolvedTimezone, now)}</span>
        </div>
      </div>

      <div className="bg-border grid grid-cols-1 gap-px overflow-clip rounded-xl border md:grid-cols-[minmax(0,1fr)_340px]">
        <div className="bg-card p-6 md:p-4">
          <AvailabilityMonthCalendar
            selectedDayKey={selectedDayKey}
            onSelectDayKey={handleSelectDayKey}
            daysAtLength={daysAtLength}
            daysShorterOnly={daysShorterOnly}
            lengthMinutes={length}
            viewerTodayKey={todayKey}
            viewerWindowEndKey={slotDayKey(windowEnd.toISOString(), resolvedTimezone)}
          />
        </div>
        <div className="bg-card min-w-0 p-6">
          <AvailabilitySlotsPanel
            dayKey={selectedDayKey}
            isToday={selectedDayKey === todayKey}
            viewerTimezone={resolvedTimezone}
            mode={mode}
            length={length}
            slotsAtLength={slotsAtLength}
            offers={offers}
            nextDayKey={nextDayKey}
            selectedSlot={selectedSlot}
            onSelectSlot={(slot) => setSelectedStart(slot.start)}
            onTakeOffer={handleTakeOffer}
            onGoToDay={handleSelectDayKey}
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
