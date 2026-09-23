'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, Calendar, Clock, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { ExpertAvailabilityCalendar } from '@/components/availability';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { track, SCHEDULE_EVENTS } from '@/lib/analytics';
import { CalendarConnectionsSection } from './calendar-connections-section';
import { DateOverridesCard } from './date-overrides-card';
import { ScheduleDayRow } from './schedule-day-row';
import { ScheduleTimezoneLine } from './schedule-timezone-line';
import { BookingRulesSection } from './booking-rules-section';
import { ScheduleEmptyState } from './schedule-empty-state';
import { ScheduleDstWarning } from './schedule-dst-warning';
import { SettingsCard, SettingsEyebrow } from './settings-card';
import { SettingsPageHeader } from './settings-page-header';
import { getScheduleAction } from '../_actions/get-schedule';
import { saveScheduleAction } from '../_actions/save-schedule';
import { clearScheduleAction } from '../_actions/clear-schedule';
import { updateScheduleTimezoneAction } from '../_actions/update-schedule-timezone';
import {
  DAY_META,
  countEnabledDays,
  createDefaultWeek,
  createEmptyWeek,
  defaultRange,
  getNextSpringForwardGap,
  findWeekGapMatch,
  hasSplitDays,
  hasOvernightWindow,
  hasLateWindow,
  changeRangeInWeek,
  removeRangeFromWeek,
  copyDayRangesInWeek,
  nextRangeDefault,
  rulesToWeek,
  evaluateWeek,
  conflictInlineMessages,
  weekToRules,
  DEFAULT_BOOKING_SETTINGS,
  type WeekState,
  type ScheduleConflict,
} from '../_lib/schedule-helpers';
import type { BookingSettings } from '../_types/schedule';

type ViewState = 'loading' | 'empty' | 'error' | 'ready';

const AVAILABILITY_HEADING_ID = 'schedule-availability-heading';
const PREVIEW_HEADING_ID = 'schedule-preview-heading';

export function ScheduleTab(): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const [viewState, setViewState] = useState<ViewState>('loading');
  const [week, setWeek] = useState<WeekState>(createEmptyWeek);
  const [bookingSettings, setBookingSettings] = useState<BookingSettings>(DEFAULT_BOOKING_SETTINGS);
  const [timezone, setTimezone] = useState('Australia/Melbourne');
  const [saving, setSaving] = useState(false);
  // BAL-236 (D15) — promoted from `expertIdRef` so the availability preview (mounted only in
  // the `ready` branch) re-renders once the id is known. The ref is KEPT: four `track(...)`
  // call sites read it synchronously inside callbacks and must not be disturbed.
  const [expertProfileId, setExpertProfileId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ScheduleConflict | null>(null);
  // Target timezone awaiting confirmation (AC12): non-null while the reinterpret
  // warning dialog is open. Only reached when the expert has active saved rules.
  const [pendingTimezone, setPendingTimezone] = useState<string | null>(null);

  /**
   * The SAVED timezone, mirrored into state alongside the ref (same reason `expertProfileId`
   * was promoted, D15: a ref does not re-render).
   *
   * ⚠ THE PREVIEW MUST RENDER AGAINST THIS, NOT `timezone`. `timezone` is the editing value —
   * changing the dropdown without saving would relabel the preview into the new zone while the
   * server grid it is showing was still computed in the persisted one, so the expert would be
   * told "what clients see" is something no client sees.
   */
  const [persistedTimezone, setPersistedTimezone] = useState('Australia/Melbourne');

  const expertIdRef = useRef<string>('');
  const persistedTimezoneRef = useRef<string>('Australia/Melbourne');
  const persistedBookingSettingsRef = useRef<BookingSettings>(DEFAULT_BOOKING_SETTINGS);
  const hasPersistedRulesRef = useRef<boolean>(false);

  const loadSchedule = useCallback(async (): Promise<void> => {
    setViewState('loading');
    const data = await getScheduleAction();
    if (!data) {
      setViewState('error');
      return;
    }
    expertIdRef.current = data.expertProfileId;
    setExpertProfileId(data.expertProfileId);
    persistedTimezoneRef.current = data.timezone;
    setPersistedTimezone(data.timezone);
    persistedBookingSettingsRef.current = data.bookingSettings;
    hasPersistedRulesRef.current = data.rules.length > 0;
    setTimezone(data.timezone);
    setBookingSettings(data.bookingSettings);
    if (data.rules.length === 0) {
      setWeek(createEmptyWeek());
      setViewState('empty');
      return;
    }
    setWeek(rulesToWeek(data.rules));
    setViewState('ready');
  }, []);

  useEffect(() => {
    loadSchedule().catch(() => undefined);
  }, [loadSchedule]);

  // ── Weekly-grid mutations ────────────────────────────────────────

  // One rule, no exceptions: every mutation clears any active conflict highlight (a stale
  // red after the expert has already fixed it but not yet re-saved would be worse than no
  // highlight at all).
  const markEdited = useCallback((): void => {
    setConflict(null);
  }, []);

  const handleToggleDay = useCallback(
    (dayIndex: number, enabled: boolean): void => {
      markEdited();
      setWeek((prev) =>
        prev.map((day, index) => {
          if (index !== dayIndex) return day;
          const ranges = enabled && day.ranges.length === 0 ? [defaultRange()] : day.ranges;
          return { ...day, enabled, ranges };
        })
      );
    },
    [markEdited]
  );

  const handleRangeChange = useCallback(
    (dayIndex: number, rangeId: string, field: 'start' | 'end', value: string): void => {
      markEdited();
      setWeek((prev) => changeRangeInWeek(prev, dayIndex, rangeId, field, value));
    },
    [markEdited]
  );

  const handleAddRange = useCallback(
    (dayIndex: number): void => {
      markEdited();
      setWeek((prev) =>
        prev.map((day, index) => {
          if (index !== dayIndex) return day;
          const nextRange = nextRangeDefault(day.ranges);
          // null means the day's free space is genuinely exhausted — nothing honest to
          // add, so leave the day as-is rather than hand over an unsaveable range.
          return nextRange ? { ...day, ranges: [...day.ranges, nextRange] } : day;
        })
      );
    },
    [markEdited]
  );

  const handleRemoveRange = useCallback(
    (dayIndex: number, rangeId: string): void => {
      markEdited();
      setWeek((prev) => removeRangeFromWeek(prev, dayIndex, rangeId));
    },
    [markEdited]
  );

  const handleCopyToDays = useCallback(
    (sourceIndex: number, targetIndices: number[]): void => {
      markEdited();
      setWeek((prev) => copyDayRangesInWeek(prev, sourceIndex, targetIndices));
    },
    [markEdited]
  );

  const handleBookingChange = useCallback(
    (next: BookingSettings): void => {
      markEdited();
      setBookingSettings(next);
    },
    [markEdited]
  );

  // ── Timezone (persisted immediately via PATCH) ───────────────────

  const commitTimezoneChange = useCallback(async (nextTimezone: string): Promise<void> => {
    const previous = persistedTimezoneRef.current;
    setTimezone(nextTimezone);
    const result = await updateScheduleTimezoneAction(nextTimezone);
    if (result.success) {
      persistedTimezoneRef.current = nextTimezone;
      setPersistedTimezone(nextTimezone);
      track(SCHEDULE_EVENTS.TIMEZONE_CHANGED, {
        expert_id: expertIdRef.current,
        from_timezone: previous,
        to_timezone: nextTimezone,
      });
      toast.success('Timezone updated');
    } else {
      setTimezone(previous);
      toast.error(result.error ?? 'Failed to update timezone');
    }
  }, []);

  // Changing timezone reinterprets every saved wall-clock rule (Melbourne 9–5 →
  // New York 9–5). Confirm first when the expert has active rules (AC12 / §3);
  // otherwise commit straight away.
  const handleTimezoneChange = useCallback(
    (nextTimezone: string): void => {
      if (nextTimezone === persistedTimezoneRef.current) return;
      if (hasPersistedRulesRef.current) {
        setPendingTimezone(nextTimezone);
        return;
      }
      void commitTimezoneChange(nextTimezone);
    },
    [commitTimezoneChange]
  );

  const confirmTimezoneChange = useCallback((): void => {
    const next = pendingTimezone;
    setPendingTimezone(null);
    if (next) void commitTimezoneChange(next);
  }, [pendingTimezone, commitTimezoneChange]);

  // ── Empty-state entry points ─────────────────────────────────────

  const handleUseDefaults = useCallback((): void => {
    setWeek(createDefaultWeek());
    setViewState('ready');
  }, []);

  const handleSetUp = useCallback((): void => {
    // Start from Monday 9–5 so there is something to shape.
    const seed = createEmptyWeek();
    const [monday] = seed;
    if (monday) {
      monday.enabled = true;
      monday.ranges = [defaultRange()];
    }
    setWeek(seed);
    setViewState('ready');
  }, []);

  // ── Save / clear ─────────────────────────────────────────────────

  const handleSave = useCallback(async (): Promise<void> => {
    // ONE evaluation decides both surfaces — the toast and the row highlight are
    // derived from the same result, so they can never disagree (F1 / BAL-415 fix
    // round). `conflict` is only ever set when `validation.message` actually narrates
    // it (e.g. never for the empty-enabled-day error).
    const validation = evaluateWeek(week);
    setConflict(validation?.conflict ?? null);
    if (validation) {
      toast.error(validation.message);
      return;
    }
    setSaving(true);
    const rules = weekToRules(week);
    const result = await saveScheduleAction({ timezone, bookingSettings, rules });
    setSaving(false);
    if (result.success) {
      persistedTimezoneRef.current = timezone;
      setPersistedTimezone(timezone);
      hasPersistedRulesRef.current = rules.length > 0;
      track(SCHEDULE_EVENTS.SAVED, {
        expert_id: expertIdRef.current,
        days_enabled: countEnabledDays(week),
        has_split_days: hasSplitDays(week),
        has_overnight_window: hasOvernightWindow(week),
        has_late_window: hasLateWindow(week),
      });
      // Fire booking_rules_saved ONLY when the settings differ from what's
      // persisted — without the change-gate it just duplicates schedule_saved.
      const prev = persistedBookingSettingsRef.current;
      if (
        bookingSettings.bufferBeforeMinutes !== prev.bufferBeforeMinutes ||
        bookingSettings.bufferAfterMinutes !== prev.bufferAfterMinutes ||
        bookingSettings.minimumNoticeMinutes !== prev.minimumNoticeMinutes
      ) {
        track(SCHEDULE_EVENTS.BOOKING_RULES_SAVED, {
          expert_id: expertIdRef.current,
          buffer_before_minutes: bookingSettings.bufferBeforeMinutes,
          buffer_after_minutes: bookingSettings.bufferAfterMinutes,
          minimum_notice_minutes: bookingSettings.minimumNoticeMinutes,
        });
      }
      persistedBookingSettingsRef.current = bookingSettings;
      toast.success('Schedule saved');
    } else {
      toast.error(result.error ?? 'Failed to save schedule');
    }
  }, [week, timezone, bookingSettings]);

  const handleClear = useCallback(async (): Promise<void> => {
    setSaving(true);
    const result = await clearScheduleAction();
    setSaving(false);
    if (result.success) {
      hasPersistedRulesRef.current = false;
      track(SCHEDULE_EVENTS.CLEARED, { expert_id: expertIdRef.current });
      setWeek(createEmptyWeek());
      setViewState('empty');
      toast.success('Schedule cleared');
    } else {
      toast.error(result.error ?? 'Failed to clear schedule');
    }
  }, []);

  // The expensive Intl spring-forward scan depends only on the timezone, so it runs
  // once per timezone change — not on every keystroke. The cheap overlap test runs
  // per edit against the already-computed gap.
  const springForwardGap = useMemo(() => getNextSpringForwardGap(timezone, new Date()), [timezone]);
  const dstMatch = useMemo(
    () => (springForwardGap ? findWeekGapMatch(week, springForwardGap) : null),
    [week, springForwardGap]
  );

  const conflictMessages = useMemo(
    () => (conflict ? conflictInlineMessages(conflict, week) : undefined),
    [conflict, week]
  );

  const timezoneKnown = viewState === 'ready' || viewState === 'empty';

  return (
    <motion.div
      className="flex flex-col gap-7"
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      <SettingsPageHeader
        icon={Calendar}
        color="#2563EB"
        title="Schedule"
        description={
          <>
            Set when you&apos;re open to consultations. These hours, minus anything busy on your
            calendar, become the times clients can book.
          </>
        }
      >
        {timezoneKnown && (
          <ScheduleTimezoneLine timezone={timezone} onChange={handleTimezoneChange} />
        )}
        {viewState === 'loading' && (
          <div
            aria-hidden="true"
            className="bg-muted h-5 w-72 max-w-full animate-pulse rounded motion-reduce:animate-none"
          />
        )}
      </SettingsPageHeader>

      <SettingsCard
        aria-labelledby={AVAILABILITY_HEADING_ID}
        className="flex flex-col gap-6 p-5 sm:p-7"
      >
        <div className="flex items-start gap-3">
          <div className="bg-violet/10 flex size-[34px] shrink-0 items-center justify-center rounded-[9px]">
            <Clock className="text-violet size-[17px]" aria-hidden="true" />
          </div>
          <div>
            <h2 id={AVAILABILITY_HEADING_ID} className="text-foreground text-base font-semibold">
              Availability
            </h2>
            <p className="text-muted-foreground mt-0.5 text-[13px]">
              Your open hours, turned into bookable slots.
            </p>
          </div>
        </div>

        {viewState === 'loading' && <ScheduleLoadingState />}

        {viewState === 'error' && <ScheduleErrorState onRetry={loadSchedule} />}

        {viewState === 'empty' && (
          <ScheduleEmptyState onUseDefaults={handleUseDefaults} onSetUp={handleSetUp} />
        )}

        {viewState === 'ready' && (
          <>
            <div className="flex flex-col gap-3">
              <SettingsEyebrow>Weekly hours</SettingsEyebrow>
              {week.map((day, index) => {
                const meta = DAY_META[index];
                return (
                  <ScheduleDayRow
                    key={meta?.dayOfWeek ?? index}
                    dayIndex={index}
                    day={day}
                    conflictMessages={conflictMessages}
                    onToggle={(enabled) => handleToggleDay(index, enabled)}
                    onRangeChange={(rangeId, field, value) =>
                      handleRangeChange(index, rangeId, field, value)
                    }
                    onAddRange={() => handleAddRange(index)}
                    onRemoveRange={(rangeId) => handleRemoveRange(index, rangeId)}
                    onCopyToDays={(targets) => handleCopyToDays(index, targets)}
                  />
                );
              })}
              {springForwardGap && dstMatch && (
                <ScheduleDstWarning gap={springForwardGap} timezone={timezone} match={dstMatch} />
              )}
            </div>

            <CardDivider />

            <BookingRulesSection settings={bookingSettings} onChange={handleBookingChange} />

            <CardDivider />

            <p className="text-muted-foreground text-[12.5px] leading-relaxed">
              Clients see these hours minus anything already busy on your connected calendar,
              converted to their own timezone.
            </p>

            <ScheduleActions saving={saving} onClear={handleClear} onSave={handleSave} />
          </>
        )}
      </SettingsCard>

      {/* BAL-397 §3.1 — Time off renders as a sibling of the calendar section, never inside
          it: a failed calendar fetch must not take Time off (an independent feature with its
          own fetch) down with it. */}
      <DateOverridesCard />

      <CalendarConnectionsSection />

      {/* BAL-236 — the resolved bookable-slot preview. Only inside `ready` (the expert has
          saved rules); in `empty`, `ScheduleEmptyState` already owns the message and a
          `not_configured` preview would just duplicate it. */}
      {viewState === 'ready' && expertProfileId && (
        <SettingsCard aria-labelledby={PREVIEW_HEADING_ID} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <SettingsEyebrow as="h2" id={PREVIEW_HEADING_ID}>
              What clients see
            </SettingsEyebrow>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              Your hours, minus anything already busy on your connected calendar.
            </p>
          </div>
          <ExpertAvailabilityCalendar
            expertProfileId={expertProfileId}
            mode="preview"
            viewerTimezone={persistedTimezone}
            daysAhead={14}
            viewerType="expert"
          />
        </SettingsCard>
      )}

      {/* Reinterpret warning — only reached when active rules exist (AC12) */}
      <AlertDialog
        open={pendingTimezone !== null}
        onOpenChange={(open) => {
          if (!open) setPendingTimezone(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change your timezone?</AlertDialogTitle>
            <AlertDialogDescription>
              Your weekly hours are saved as clock times. Switching timezone keeps the same clock
              times but reads them in the new zone — 9:00 AM stays 9:00 AM, but it now lands at a
              different real moment, so every bookable slot shifts. Busy times on your connected
              calendar aren&apos;t affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current timezone</AlertDialogCancel>
            <AlertDialogAction onClick={confirmTimezoneChange}>Change timezone</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}

function CardDivider(): React.JSX.Element {
  return <div aria-hidden="true" className="bg-border/60 h-px" />;
}

interface ScheduleActionsProps {
  saving: boolean;
  onClear: () => Promise<void>;
  onSave: () => Promise<void>;
}

/** "Clear schedule" (confirmed first — it is destructive) on the left, "Save schedule" right. */
function ScheduleActions({
  saving,
  onClear,
  onSave,
}: Readonly<ScheduleActionsProps>): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="link"
            disabled={saving}
            className="text-muted-foreground hover:text-destructive h-11 px-0 text-[13px] sm:h-9"
          >
            Clear schedule
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear your whole schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              Clients won&apos;t be able to book you until you set your hours again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onClear}
              className={buttonVariants({ variant: 'destructive' })}
            >
              Yes, clear it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Button type="button" onClick={onSave} disabled={saving}>
        {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        Save schedule
      </Button>
    </div>
  );
}

/** Skeleton of the seven day rows, so the card keeps its shape while hours load. */
function ScheduleLoadingState(): React.JSX.Element {
  return (
    <output className="flex flex-col gap-3">
      <span className="sr-only">Loading your hours</span>
      {DAY_META.map((meta) => (
        <div key={meta.dayOfWeek} aria-hidden="true" className="flex h-9 items-center gap-3.5">
          <div className="bg-muted h-[18px] w-8 animate-pulse rounded-full motion-reduce:animate-none" />
          <div className="bg-muted h-3.5 w-10 animate-pulse rounded motion-reduce:animate-none" />
          <div className="bg-muted h-8 w-[112px] animate-pulse rounded-md motion-reduce:animate-none" />
          <div className="bg-muted hidden h-8 w-[112px] animate-pulse rounded-md motion-reduce:animate-none sm:block" />
        </div>
      ))}
    </output>
  );
}

function ScheduleErrorState({ onRetry }: Readonly<{ onRetry: () => void }>): React.JSX.Element {
  return (
    <div className="border-destructive/30 bg-destructive/5 flex flex-col items-start gap-3 rounded-lg border p-4">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="text-destructive mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div>
          <h3 className="text-foreground text-sm font-semibold">
            We couldn&apos;t load your hours
          </h3>
          <p className="text-muted-foreground mt-1 max-w-md text-[13px] leading-relaxed">
            Something went wrong on our end. Try again in a moment — if it keeps happening,
            we&apos;re already looking into it.
          </p>
        </div>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        Try again
      </Button>
    </div>
  );
}
