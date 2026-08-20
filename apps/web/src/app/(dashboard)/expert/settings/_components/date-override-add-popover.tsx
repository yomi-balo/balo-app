'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { Loader2, Plus } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { track, AVAILABILITY_EVENTS, type AvailabilityConflictResolution } from '@/lib/analytics';
import { formatOverrideRange } from '../_lib/format-override-range';
import { DateOverrideConflictWarning } from './date-override-conflict-warning';
import type {
  AvailabilityConflictCheckInput,
  AvailabilityConflictReportDto,
} from '../_types/availability-conflict';

export interface CreateOverrideInput {
  startDate: string;
  endDate: string;
  label?: string;
}

/** @deprecated use {@link AvailabilityConflictCheckInput} — kept as an alias so existing callers don't churn. */
export type CheckConflictsInput = AvailabilityConflictCheckInput;

interface DateOverrideAddPopoverProps {
  /** Returns true when the block was created (so the popover can reset + close). */
  onCreate: (input: CreateOverrideInput) => Promise<boolean>;
  /**
   * BAL-416 — the silent conflict pre-check. Injected (not imported) so this component's
   * tests need no Server Action mock — matching how `onCreate` is already injected.
   *
   * ⚠ MUST BE REFERENTIALLY STABLE. This is a dependency of the debounced prefetch
   * `useEffect`, so an inline arrow (or any per-render-recreated function) at the call site
   * re-fires the debounce timer — and the underlying conflict check — on every render,
   * turning this into a request storm. `DateOverridesCard` satisfies this today by passing
   * the module-level `getOverrideConflictsAction` Server Action directly (a stable
   * reference); wrap any future non-Server-Action caller in `useCallback`.
   */
  onCheckConflicts: (input: CheckConflictsInput) => Promise<AvailabilityConflictReportDto | null>;
  /**
   * Purely an analytics dimension — joins the two BAL-416 client events to the expert.
   * `null` while the card's own profile fetch is still in flight (the popover is reachable
   * before that resolves); every `track()` call below skips firing rather than shipping an
   * empty-string dimension.
   */
  expertProfileId: string | null;
}

/** Format a local `Date` (react-day-picker gives local-midnight dates) as `YYYY-MM-DD`. */
function toIsoDate(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, '0');
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** `to` undefined = a single-day selection: the block collapses to one day. */
function toDates(from: Date, to: Date | undefined): { startDate: string; endDate: string } {
  return { startDate: toIsoDate(from), endDate: toIsoDate(to ?? from) };
}

export function DateOverrideAddPopover({
  onCreate,
  onCheckConflicts,
  expertProfileId,
}: Readonly<DateOverrideAddPopoverProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [label, setLabel] = useState('');
  const [pending, setPending] = useState(false);
  const [view, setView] = useState<'pick' | 'conflicts'>('pick');
  const [report, setReport] = useState<AvailabilityConflictReportDto | null>(null);

  // The in-flight (or most recently settled) conflict check for the CURRENT selection, plus
  // a monotonically-increasing token so a slow earlier response can never be read for a
  // range the expert has since changed.
  const requestRef = useRef<{
    token: number;
    promise: Promise<AvailabilityConflictReportDto | null>;
  } | null>(null);
  const tokenRef = useRef(0);
  // R1 — the pending debounce timer, so a submit that beats the 250ms window can FLUSH it
  // (clear + arm now) instead of racing it and reading a `requestRef` nothing has populated.
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // R5 — per-decision resolution latch: true once THIS conflict decision has already emitted
  // its one `..._resolved` event, on EITHER arm (`blocked_anyway` or `abandoned`). Reset only
  // when a NEW decision begins (in `handleSubmit`, right before showing the warning) — never
  // in `reset()`, which can itself run mid-decision (see `dismissDuringConfirmRef` below) and
  // must not erase a flag a concurrent dismiss just set.
  const resolvedRef = useRef(false);
  // R5 — set when the popover is dismissed WHILE "Block dates anyway" is still in flight. The
  // dismiss cannot yet know whether the confirm will land as `blocked_anyway` or fail (→
  // `abandoned`), so it defers to `handleConfirm`'s own continuation rather than guessing.
  const dismissDuringConfirmRef = useRef(false);

  // SUGGESTION — `expertProfileId` is `null` while the card's own profile fetch is still in
  // flight; shipping `expert_profile_id: ''` would be a silent bad analytics dimension, so
  // both conflict events go through one of these two and simply don't fire until it resolves.
  // Two narrowly-typed helpers rather than one generic one: `track()`'s payload type is keyed
  // to the specific event literal, and a single helper generic enough to cover both events'
  // differently-shaped payloads loses that correlation (TS can no longer check the payload
  // against the right shape).
  const trackDetected = useCallback(
    (payload: { conflict_count: number; duration_days: number }): void => {
      if (expertProfileId === null) return;
      track(AVAILABILITY_EVENTS.OVERRIDE_CONFLICT_DETECTED, {
        ...payload,
        expert_profile_id: expertProfileId,
      });
    },
    [expertProfileId]
  );

  const trackResolved = useCallback(
    (payload: { resolution: AvailabilityConflictResolution; conflict_count: number }): void => {
      if (expertProfileId === null) return;
      track(AVAILABILITY_EVENTS.OVERRIDE_CONFLICT_RESOLVED, {
        ...payload,
        expert_profile_id: expertProfileId,
      });
    },
    [expertProfileId]
  );

  // Local-midnight today. Past dates are hidden by `listUpcoming` on refresh, so
  // blocking them at the source prevents a phantom/inconsistent optimistic row.
  // `{ before: today }` is exclusive of `today`, so today itself stays selectable.
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const rangeFrom = range?.from;
  const rangeTo = range?.to;

  // R1 — hoisted out of the effect so `handleSubmit` can call it too. A submit inside the
  // debounce window must ARM AND AWAIT the check itself rather than reading a `requestRef`
  // the debounce timer hasn't populated yet.
  const armCheck = useCallback(
    (
      from: Date,
      to: Date | undefined
    ): { token: number; promise: Promise<AvailabilityConflictReportDto | null> } => {
      const token = ++tokenRef.current;
      // C1 (fail-open, D10) — a rejected check must NEVER strand this promise: `handleSubmit`
      // awaits it directly, so an unhandled rejection here would throw THERE, skip the
      // `onCreate` fallback, and (before the `finally` below) leave `pending` stuck forever.
      // `.catch(() => null)` makes the stored promise incapable of rejecting AND removes the
      // unhandled-rejection noise this used to throw at `window.onunhandledrejection`/Sentry.
      const promise = onCheckConflicts(toDates(from, to)).catch(() => null);
      const entry = { token, promise };
      requestRef.current = entry;
      return entry;
    },
    [onCheckConflicts]
  );

  // ⚠ SILENT PREFETCH (D9/D10). AC 1 requires a zero-conflict range to behave EXACTLY as
  // today, so this renders NOTHING — no spinner, no "Checking…" line — and never touches
  // `pending`. It only warms `requestRef` so `handleSubmit`'s await is a no-op in the common
  // case; the existing button spinner already covers the rare slow-check wait.
  //
  // ⚠ S4 — DEBOUNCED ~250ms. `mode="range"` fires this effect at LEAST twice per selection
  // (the intermediate `{from, to: undefined}` state, then the completed range), and every
  // firing is a full Server Action → Fastify → ~40+ DB round trip. The `clearTimeout` on
  // cleanup means only the LAST selection in a debounce window ever actually calls
  // `onCheckConflicts` — earlier ones are cancelled before they fire, not raced afterward.
  //
  // ⚠ R1 — A SUBMIT INSIDE THIS WINDOW MUST NOT READ A NULL `requestRef`. `handleSubmit`
  // flushes `timeoutRef` and calls `armCheck` itself when nothing has armed yet, so "no check
  // has been ARMED" (submit beat the debounce) can never be confused with "the check FAILED"
  // (D10's real fail-open) — only the second may skip the check.
  useEffect(() => {
    if (!rangeFrom) {
      requestRef.current = null;
      return;
    }
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      armCheck(rangeFrom, rangeTo);
    }, 250);
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [rangeFrom, rangeTo, armCheck]);

  const reset = useCallback(() => {
    setRange(undefined);
    setLabel('');
    setView('pick');
    setReport(null);
    // C1 (belt-and-braces) — closing/reopening the popover must always release a stuck
    // `pending`, even if some future caller reaches `reset()` without routing through a
    // `finally`.
    setPending(false);
    requestRef.current = null;
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  /**
   * Called when the popover is dismissed. R5 — must not GUESS the outcome of an in-flight
   * confirm: while `pending`, the only in-flight operation is `handleConfirm`'s `onCreate`
   * call, so this only FLAGS the dismiss and lets that call's own continuation decide
   * `blocked_anyway` vs `abandoned` once the real outcome is known — deciding here risks
   * mislabeling a block that is about to succeed as abandoned (or, the reverse bug this
   * replaces, staying silent forever if it doesn't). `resolvedRef` guarantees each decision
   * emits exactly one event no matter which of the two paths gets there first.
   */
  const resolveOnDismiss = useCallback(() => {
    if (view !== 'conflicts' || report === null || resolvedRef.current) return;
    if (pending) {
      dismissDuringConfirmRef.current = true;
      return;
    }
    resolvedRef.current = true;
    trackResolved({ resolution: 'abandoned', conflict_count: report.conflictCount });
  }, [view, report, pending, trackResolved]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        resolveOnDismiss();
      }
      setOpen(next);
      if (!next) reset();
    },
    [reset, resolveOnDismiss]
  );

  const handleSubmit = useCallback(async () => {
    if (!rangeFrom) return;
    setPending(true);
    // C1 — EVERY exit from this body (return, throw from a rejecting `onCreate`) releases
    // `pending` exactly once via `finally`, so a rejection can no longer strand the button.
    try {
      // R1 — flush the debounce: a submit inside the 250ms window must ARM the check itself
      // rather than reading a `requestRef` the timer hasn't populated yet. Only a genuinely
      // FAILED check (handled below via `effectiveReport === null`) may fail open.
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      const inFlight = requestRef.current ?? armCheck(rangeFrom, rangeTo);
      const settledReport = await inFlight.promise;
      // A superseded response must never gate a range the expert has since changed (edge
      // case 11). `requestRef.current` is re-armed on every range change (by the debounce
      // effect, or synchronously above), so a token mismatch means a newer request has since
      // started for a different selection.
      // ⚠ Q4 — THIS DOES NOT MERELY "DISCARD" THE STALE RESPONSE. `effectiveReport` becomes
      // `null`, which takes the SAME fail-open branch as a genuinely failed check (D10), so
      // the submit PROCEEDS UNCHECKED for the CURRENT range — creating the block with no
      // conflict check at all for whatever selection is live at submit time. That is a
      // defensible degradation (a stale-token race is rare, and D10 already treats "no check
      // ran" as safe), but it is a real behaviour, not a no-op.
      const isCurrent = requestRef.current?.token === inFlight.token;
      const effectiveReport = isCurrent ? settledReport : null;

      if (effectiveReport === null || effectiveReport.conflictCount === 0) {
        const { startDate, endDate } = toDates(rangeFrom, rangeTo);
        const trimmed = label.trim();
        const created = await onCreate({
          startDate,
          endDate,
          label: trimmed.length > 0 ? trimmed : undefined,
        });
        if (created) {
          reset();
          setOpen(false);
        }
        return;
      }

      trackDetected({
        conflict_count: effectiveReport.conflictCount,
        duration_days: effectiveReport.durationDays,
      });
      // R5 — a fresh decision starts with a clean latch; any previous decision has already
      // resolved by the time a new one can begin (there is only ever one report/view live).
      resolvedRef.current = false;
      dismissDuringConfirmRef.current = false;
      setReport(effectiveReport);
      setView('conflicts');
    } finally {
      setPending(false);
    }
  }, [rangeFrom, rangeTo, label, onCreate, reset, trackDetected, armCheck]);

  const handleConfirm = useCallback(async () => {
    if (!rangeFrom || report === null) return;
    // Captured now — R5's deferred `abandoned` path can run AFTER a dismiss has already reset
    // `report` to `null`, so this closure (not the live state) is what a late-resolving
    // `onCreate` reads.
    const currentReport = report;
    setPending(true);
    // C1 — same unconditional release as `handleSubmit`; a rejecting `onCreate` (a
    // pre-existing hazard, cheap to close here too) can no longer strand the button.
    try {
      const { startDate, endDate } = toDates(rangeFrom, rangeTo);
      const trimmed = label.trim();
      const created = await onCreate({
        startDate,
        endDate,
        label: trimmed.length > 0 ? trimmed : undefined,
      });
      if (created) {
        if (!resolvedRef.current) {
          resolvedRef.current = true;
          trackResolved({
            resolution: 'blocked_anyway',
            conflict_count: currentReport.conflictCount,
          });
        }
        reset();
        setOpen(false);
      } else if (dismissDuringConfirmRef.current && !resolvedRef.current) {
        // R5 — the popover was dismissed while this confirm was in flight, and it did NOT
        // succeed: the decision really is abandoned, not a block that silently vanished. If
        // the popover is still open instead, do nothing — the caller's toast has already
        // surfaced the failure, and an eventual retry or explicit "Choose other dates" still
        // resolves this decision exactly once.
        resolvedRef.current = true;
        trackResolved({ resolution: 'abandoned', conflict_count: currentReport.conflictCount });
      }
    } finally {
      setPending(false);
    }
  }, [rangeFrom, rangeTo, label, report, onCreate, reset, trackResolved]);

  const handleBack = useCallback(() => {
    if (report !== null && !resolvedRef.current) {
      resolvedRef.current = true;
      trackResolved({ resolution: 'abandoned', conflict_count: report.conflictCount });
    }
    setView('pick');
    setReport(null);
  }, [report, trackResolved]);

  const rangeLabel = useMemo(() => {
    if (view !== 'conflicts' || !rangeFrom) return '';
    const { startDate, endDate } = toDates(rangeFrom, rangeTo);
    return formatOverrideRange(startDate, endDate);
  }, [view, rangeFrom, rangeTo]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-11 shrink-0 gap-1.5 focus-visible:ring-2">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add time off
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        {view === 'conflicts' && report !== null ? (
          <DateOverrideConflictWarning
            report={report}
            rangeLabel={rangeLabel}
            pending={pending}
            onConfirm={handleConfirm}
            onBack={handleBack}
          />
        ) : (
          <>
            <Calendar
              mode="range"
              selected={range}
              onSelect={setRange}
              numberOfMonths={1}
              disabled={{ before: today }}
              autoFocus
              className="p-3"
            />
            <div className="border-border space-y-3 border-t p-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="date-override-label"
                  className="text-muted-foreground block text-xs font-medium"
                >
                  Label (optional)
                </label>
                <Input
                  id="date-override-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={80}
                  placeholder="e.g. Holiday"
                  className="h-9"
                />
              </div>
              <Button
                onClick={handleSubmit}
                disabled={!range?.from || pending}
                className="h-11 w-full focus-visible:ring-2"
              >
                {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Block these dates
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
