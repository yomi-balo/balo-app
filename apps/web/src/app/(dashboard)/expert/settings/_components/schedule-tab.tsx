'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, Clock, Info, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { IconBadge } from '@/components/balo/icon-badge';
import { Button, buttonVariants } from '@/components/ui/button';
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
import { CalendarTab } from './calendar-tab';
import { ScheduleDayRow } from './schedule-day-row';
import { ScheduleTimezoneCombobox } from './schedule-timezone-combobox';
import { BookingRulesSection } from './booking-rules-section';
import { ScheduleEmptyState } from './schedule-empty-state';
import { ScheduleSavedSummary } from './schedule-saved-summary';
import { ScheduleDstWarning } from './schedule-dst-warning';
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
  findDstConflict,
  hasSplitDays,
  hhmmToMinutes,
  minutesToHhmm,
  nextRangeDefault,
  newRangeId,
  rulesToWeek,
  validateWeek,
  weekToRules,
  DEFAULT_BOOKING_SETTINGS,
  type WeekState,
} from '../_lib/schedule-helpers';
import type { BookingSettings } from '../_types/schedule';

type ViewState = 'loading' | 'empty' | 'error' | 'ready';

const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' as const } },
};

export function ScheduleTab(): React.JSX.Element {
  const [viewState, setViewState] = useState<ViewState>('loading');
  const [week, setWeek] = useState<WeekState>(createEmptyWeek);
  const [bookingSettings, setBookingSettings] = useState<BookingSettings>(DEFAULT_BOOKING_SETTINGS);
  const [timezone, setTimezone] = useState('Australia/Melbourne');
  const [saving, setSaving] = useState(false);
  const [showSavedSummary, setShowSavedSummary] = useState(false);

  const expertIdRef = useRef<string>('');
  const persistedTimezoneRef = useRef<string>('Australia/Melbourne');

  const loadSchedule = useCallback(async (): Promise<void> => {
    setViewState('loading');
    const data = await getScheduleAction();
    if (!data) {
      setViewState('error');
      return;
    }
    expertIdRef.current = data.expertProfileId;
    persistedTimezoneRef.current = data.timezone;
    setTimezone(data.timezone);
    setBookingSettings(data.bookingSettings);
    if (data.rules.length === 0) {
      setWeek(createEmptyWeek());
      setShowSavedSummary(false);
      setViewState('empty');
      return;
    }
    setWeek(rulesToWeek(data.rules));
    setShowSavedSummary(true);
    setViewState('ready');
  }, []);

  useEffect(() => {
    loadSchedule().catch(() => undefined);
  }, [loadSchedule]);

  // ── Weekly-grid mutations ────────────────────────────────────────

  const handleToggleDay = useCallback((dayIndex: number, enabled: boolean): void => {
    setShowSavedSummary(false);
    setWeek((prev) =>
      prev.map((day, index) => {
        if (index !== dayIndex) return day;
        const ranges = enabled && day.ranges.length === 0 ? [defaultRange()] : day.ranges;
        return { ...day, enabled, ranges };
      })
    );
  }, []);

  const handleRangeChange = useCallback(
    (dayIndex: number, rangeId: string, field: 'start' | 'end', value: string): void => {
      setShowSavedSummary(false);
      setWeek((prev) =>
        prev.map((day, index) => {
          if (index !== dayIndex) return day;
          return {
            ...day,
            ranges: day.ranges.map((range) => {
              if (range.id !== rangeId) return range;
              if (field === 'start') {
                const nextEnd =
                  value >= range.end ? minutesToHhmm(hhmmToMinutes(value) + 15) : range.end;
                return { ...range, start: value, end: nextEnd };
              }
              return { ...range, end: value };
            }),
          };
        })
      );
    },
    []
  );

  const handleAddRange = useCallback((dayIndex: number): void => {
    setShowSavedSummary(false);
    setWeek((prev) =>
      prev.map((day, index) =>
        index === dayIndex ? { ...day, ranges: [...day.ranges, nextRangeDefault(day.ranges)] } : day
      )
    );
  }, []);

  const handleRemoveRange = useCallback((dayIndex: number, rangeId: string): void => {
    setShowSavedSummary(false);
    setWeek((prev) =>
      prev.map((day, index) => {
        if (index !== dayIndex) return day;
        const ranges = day.ranges.filter((range) => range.id !== rangeId);
        return { ...day, ranges, enabled: ranges.length > 0 && day.enabled };
      })
    );
  }, []);

  const handleCopyToDays = useCallback((sourceIndex: number, targetIndices: number[]): void => {
    setShowSavedSummary(false);
    setWeek((prev) => {
      const source = prev[sourceIndex];
      if (!source) return prev;
      const targets = new Set(targetIndices);
      return prev.map((day, index) => {
        if (!targets.has(index)) return day;
        return {
          ...day,
          enabled: true,
          ranges: source.ranges.map((range) => ({ ...range, id: newRangeId() })),
        };
      });
    });
  }, []);

  const handleBookingChange = useCallback((next: BookingSettings): void => {
    setShowSavedSummary(false);
    setBookingSettings(next);
  }, []);

  // ── Timezone (persisted immediately via PATCH) ───────────────────

  const handleTimezoneChange = useCallback(async (nextTimezone: string): Promise<void> => {
    const previous = persistedTimezoneRef.current;
    if (nextTimezone === previous) return;
    setTimezone(nextTimezone);
    const result = await updateScheduleTimezoneAction(nextTimezone);
    if (result.success) {
      persistedTimezoneRef.current = nextTimezone;
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
    const validationError = validateWeek(week);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    setSaving(true);
    const result = await saveScheduleAction({
      timezone,
      bookingSettings,
      rules: weekToRules(week),
    });
    setSaving(false);
    if (result.success) {
      persistedTimezoneRef.current = timezone;
      track(SCHEDULE_EVENTS.SAVED, {
        expert_id: expertIdRef.current,
        days_enabled: countEnabledDays(week),
        has_split_days: hasSplitDays(week),
      });
      track(SCHEDULE_EVENTS.BOOKING_RULES_SAVED, { expert_id: expertIdRef.current });
      setShowSavedSummary(true);
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
      track(SCHEDULE_EVENTS.CLEARED, { expert_id: expertIdRef.current });
      setWeek(createEmptyWeek());
      setShowSavedSummary(false);
      setViewState('empty');
      toast.success('Schedule cleared');
    } else {
      toast.error(result.error ?? 'Failed to clear schedule');
    }
  }, []);

  const dstGap = useMemo(() => findDstConflict(week, timezone, new Date()), [week, timezone]);

  return (
    <div>
      <motion.div variants={containerVariants} initial="hidden" animate="show">
        {/* Header */}
        <motion.div variants={itemVariants} className="mb-8 flex items-center gap-3">
          <IconBadge icon={Clock} color="#2563EB" size={44} iconSize={22} />
          <div>
            <h1 className="text-foreground text-2xl font-semibold">Schedule</h1>
            <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">
              Set when you&apos;re open to consultations. These hours, minus anything busy on your
              calendar, become the times clients can book.
            </p>
          </div>
        </motion.div>

        <motion.div variants={itemVariants}>
          {viewState === 'loading' && (
            <div className="flex items-center justify-center py-12">
              <Loader2
                className="text-muted-foreground h-6 w-6 animate-spin"
                aria-label="Loading"
              />
            </div>
          )}

          {viewState === 'error' && <ScheduleErrorState onRetry={loadSchedule} />}

          {viewState === 'empty' && (
            <ScheduleEmptyState onUseDefaults={handleUseDefaults} onSetUp={handleSetUp} />
          )}

          {viewState === 'ready' && (
            <div className="flex flex-col gap-4">
              {/* Timezone */}
              <section className="border-border bg-card rounded-xl border p-6">
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-primary text-[11px] font-bold tracking-wider uppercase">
                    Timezone
                  </span>
                </div>
                <ScheduleTimezoneCombobox value={timezone} onChange={handleTimezoneChange} />
                <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
                  Your hours are set in this timezone. Clients see slots converted to their own.
                </p>
              </section>

              {/* Weekly hours */}
              <section className="border-border bg-card rounded-xl border p-6">
                <div className="mb-1.5 flex items-center gap-2">
                  <Clock className="text-primary h-3.5 w-3.5" aria-hidden="true" />
                  <span className="text-primary text-[11px] font-bold tracking-wider uppercase">
                    Weekly hours
                  </span>
                </div>
                <p className="text-muted-foreground mb-2 text-sm leading-relaxed">
                  Set the hours you&apos;re open to consultations each week.
                </p>
                <div>
                  {week.map((day, index) => {
                    const meta = DAY_META[index];
                    return (
                      <ScheduleDayRow
                        key={meta?.dayOfWeek ?? index}
                        dayIndex={index}
                        day={day}
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
                </div>
              </section>

              {dstGap && <ScheduleDstWarning gap={dstGap} timezone={timezone} />}

              {/* Booking rules */}
              <BookingRulesSection settings={bookingSettings} onChange={handleBookingChange} />

              {showSavedSummary && <ScheduleSavedSummary week={week} timezone={timezone} />}

              {/* Actions */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={saving}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
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
                        onClick={handleClear}
                        className={buttonVariants({ variant: 'destructive' })}
                      >
                        Yes, clear it
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <Button type="button" onClick={handleSave} disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  Save schedule
                </Button>
              </div>
            </div>
          )}
        </motion.div>

        {/* Calendar link context — between the editor and the calendar connection */}
        <motion.div
          variants={itemVariants}
          className="text-muted-foreground mt-6 flex items-start gap-2 px-0.5 text-xs leading-relaxed"
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            These are the hours you&apos;re open. We automatically hide any times you&apos;re
            already busy on your connected calendar, so clients only see when you&apos;re genuinely
            free.
          </span>
        </motion.div>
      </motion.div>

      {/* Existing calendar connection, stacked below the weekly editor */}
      <div className="border-border/60 mt-8 border-t pt-8">
        <CalendarTab />
      </div>
    </div>
  );
}

function ScheduleErrorState({ onRetry }: Readonly<{ onRetry: () => void }>): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-xl border p-10 text-center">
      <div className="mb-4 flex justify-center">
        <IconBadge icon={AlertTriangle} color="#DC2626" size={52} iconSize={24} />
      </div>
      <h2 className="text-foreground text-base font-semibold">We couldn&apos;t load your hours</h2>
      <p className="text-muted-foreground mx-auto mt-2 max-w-sm text-sm leading-relaxed">
        Something went wrong on our end. Try again in a moment — if it keeps happening, we&apos;re
        already looking into it.
      </p>
      <Button type="button" variant="outline" className="mt-5" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        Try again
      </Button>
    </div>
  );
}
