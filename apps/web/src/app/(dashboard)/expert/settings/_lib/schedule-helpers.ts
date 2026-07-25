import { z } from 'zod';
import { getNextSpringForwardGap, type SpringForwardGap } from '@balo/shared/timezone';
import type { BookingSettings, ScheduleData, ScheduleRule } from '../_types/schedule';

// ── Editor state model ──────────────────────────────────────────────
// The weekly grid is authored Monday-first (display order). Each editor row maps
// to a JS `dayOfWeek` (0=Sun … 6=Sat) via DAY_META for the wire contract.

/** One wall-clock range, 'HH:mm' strings on 15-minute boundaries. */
export interface TimeRange {
  /** Stable client-side id for React keys (never sent to the API). */
  id: string;
  start: string;
  end: string;
}

/** Fresh stable id for a new editor range. */
export function newRangeId(): string {
  return globalThis.crypto.randomUUID();
}

/** One weekday's editor state. */
export interface DayState {
  enabled: boolean;
  ranges: TimeRange[];
}

/** Full week, length 7, index 0=Mon … 6=Sun (display order). */
export type WeekState = DayState[];

interface DayMeta {
  /** JS day-of-week for the wire contract (0=Sun … 6=Sat). */
  dayOfWeek: number;
  short: string;
  full: string;
}

/** Display order: Monday-first. */
export const DAY_META: readonly DayMeta[] = [
  { dayOfWeek: 1, short: 'Mon', full: 'Monday' },
  { dayOfWeek: 2, short: 'Tue', full: 'Tuesday' },
  { dayOfWeek: 3, short: 'Wed', full: 'Wednesday' },
  { dayOfWeek: 4, short: 'Thu', full: 'Thursday' },
  { dayOfWeek: 5, short: 'Fri', full: 'Friday' },
  { dayOfWeek: 6, short: 'Sat', full: 'Saturday' },
  { dayOfWeek: 0, short: 'Sun', full: 'Sunday' },
];

export const MAX_RANGES_PER_DAY = 3;
export const TIME_STEP_MINUTES = 15;
const MINUTES_PER_DAY = 24 * 60;
const DEFAULT_START = '09:00';
const DEFAULT_END = '17:00';
/**
 * Latest selectable START time. With a 15-minute minimum range, 23:45 as a start
 * would leave no valid end (any auto-bump clamps back to 23:45 → start === end,
 * an error the expert can't clear). 23:30 is the last start that keeps an end
 * selectable.
 */
export const LATEST_START_HHMM = '23:30';

// ── Time helpers ────────────────────────────────────────────────────

export function hhmmToMinutes(value: string): number {
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

export function minutesToHhmm(minutes: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY - TIME_STEP_MINUTES, minutes));
  const hours = Math.floor(clamped / 60);
  const mins = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/** '09:00' → '9:00 AM'. */
export function formatHhmm(value: string): string {
  const total = hhmmToMinutes(value);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  const period = hours < 12 ? 'AM' : 'PM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(mins).padStart(2, '0')} ${period}`;
}

export interface TimeOption {
  value: string;
  label: string;
}

/** All 15-minute slots, 00:00 → 23:45. Used for END pickers. */
export const TIME_OPTIONS: readonly TimeOption[] = Array.from(
  { length: MINUTES_PER_DAY / TIME_STEP_MINUTES },
  (_unused, index) => {
    const value = minutesToHhmm(index * TIME_STEP_MINUTES);
    return { value, label: formatHhmm(value) };
  }
);

/** START-picker slots, 00:00 → 23:30 (a valid end must always remain selectable). */
export const START_TIME_OPTIONS: readonly TimeOption[] = TIME_OPTIONS.filter(
  (option) => option.value <= LATEST_START_HHMM
);

// ── Booking-rule option sets (exact sets from availability-editor.jsx) ──

export interface RuleOption {
  value: number;
  label: string;
}

export const BUFFER_OPTIONS: readonly RuleOption[] = [
  { value: 0, label: 'None' },
  { value: 5, label: '5 min' },
  { value: 10, label: '10 min' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
];

export const NOTICE_OPTIONS: readonly RuleOption[] = [
  { value: 0, label: 'No minimum' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 240, label: '4 hours' },
  { value: 720, label: '12 hours' },
  { value: 1440, label: '1 day' },
  { value: 2880, label: '2 days' },
];

export const DEFAULT_BOOKING_SETTINGS: BookingSettings = {
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minimumNoticeMinutes: 0,
};

// ── Default / seed schedule ─────────────────────────────────────────

/** Mon–Fri 9:00 AM – 5:00 PM enabled; Sat/Sun off. */
export function createDefaultWeek(): WeekState {
  return DAY_META.map((_meta, index) => ({
    enabled: index < 5,
    ranges: index < 5 ? [{ id: newRangeId(), start: DEFAULT_START, end: DEFAULT_END }] : [],
  }));
}

export function createEmptyWeek(): WeekState {
  return DAY_META.map(() => ({ enabled: false, ranges: [] }));
}

/** A single default range (used when enabling a day that has no ranges). */
export function defaultRange(): TimeRange {
  return { id: newRangeId(), start: DEFAULT_START, end: DEFAULT_END };
}

/** Default range appended when adding to a day: after the last range, capped to end-of-day. */
export function nextRangeDefault(existing: TimeRange[]): TimeRange {
  const last = existing.at(-1);
  if (!last) return defaultRange();
  const startMinutes = Math.min(hhmmToMinutes(last.end) + 60, MINUTES_PER_DAY - TIME_STEP_MINUTES);
  const endMinutes = Math.min(startMinutes + 60, MINUTES_PER_DAY - TIME_STEP_MINUTES);
  return { id: newRangeId(), start: minutesToHhmm(startMinutes), end: minutesToHhmm(endMinutes) };
}

// ── Wire-contract conversion ────────────────────────────────────────

export function weekToRules(week: WeekState): ScheduleRule[] {
  const rules: ScheduleRule[] = [];
  week.forEach((day, index) => {
    const meta = DAY_META[index];
    if (!meta || !day.enabled) return;
    for (const range of day.ranges) {
      rules.push({ dayOfWeek: meta.dayOfWeek, startTime: range.start, endTime: range.end });
    }
  });
  return rules;
}

export function rulesToWeek(rules: readonly ScheduleRule[]): WeekState {
  const week = createEmptyWeek();
  for (const rule of rules) {
    const index = DAY_META.findIndex((meta) => meta.dayOfWeek === rule.dayOfWeek);
    if (index === -1) continue;
    const day = week[index];
    if (!day) continue;
    day.enabled = true;
    day.ranges.push({ id: newRangeId(), start: rule.startTime, end: rule.endTime });
  }
  // Keep ranges within each day ordered by start for stable rendering.
  for (const day of week) {
    day.ranges.sort((a, b) => hhmmToMinutes(a.start) - hhmmToMinutes(b.start));
  }
  return week;
}

// ── Derived metrics (analytics) ─────────────────────────────────────

export function countEnabledDays(week: WeekState): number {
  return week.filter((day) => day.enabled && day.ranges.length > 0).length;
}

export function hasSplitDays(week: WeekState): boolean {
  return week.some((day) => day.enabled && day.ranges.length > 1);
}

// ── Validation (local zod, mirrors the API contract) ────────────────

// Anchored, no nested quantifiers — safe against ReDoS (SonarCloud S5852).
export const HHMM_REGEX = /^([01]\d|2[0-3]):(00|15|30|45)$/;

export const scheduleRuleSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z.string().regex(HHMM_REGEX, 'Time must be on a 15-minute boundary'),
    endTime: z.string().regex(HHMM_REGEX, 'Time must be on a 15-minute boundary'),
  })
  .refine((rule) => rule.startTime < rule.endTime, {
    message: 'End time must be after start time',
  });

export const scheduleRulesSchema = z.array(scheduleRuleSchema).max(21);

/**
 * Validates the editor week. Returns a user-facing error string, or null when valid.
 * Runs the shared zod rule schema and adds a friendly per-day overlap check.
 */
export function validateWeek(week: WeekState): string | null {
  for (const [index, day] of week.entries()) {
    const meta = DAY_META[index];
    if (!day.enabled || !meta) continue;
    if (day.ranges.length === 0) {
      return `Add hours to ${meta.full}, or turn the day off.`;
    }
    const sorted = [...day.ranges].sort((a, b) => hhmmToMinutes(a.start) - hhmmToMinutes(b.start));
    let previousEnd = -1;
    for (const range of sorted) {
      if (hhmmToMinutes(range.start) < previousEnd) {
        return `Time ranges on ${meta.full} overlap.`;
      }
      previousEnd = hhmmToMinutes(range.end);
    }
  }

  const parsed = scheduleRulesSchema.safeParse(weekToRules(week));
  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? 'Please review your schedule.';
  }
  return null;
}

// ── Saved-summary text (BAL-236 fallback) ───────────────────────────

export interface ScheduleSummarySegment {
  /** e.g. 'Mon–Fri' or 'Wed'. */
  days: string;
  /** e.g. '9:00 AM – 5:00 PM' or '9:00 AM – 1:00 PM, 2:00 PM – 5:00 PM'. */
  hours: string;
}

function rangesSignature(ranges: TimeRange[]): string {
  return ranges.map((range) => `${range.start}-${range.end}`).join(',');
}

function rangesLabel(ranges: TimeRange[]): string {
  return ranges.map((range) => `${formatHhmm(range.start)} – ${formatHhmm(range.end)}`).join(', ');
}

/**
 * Groups consecutive (display-order) enabled days sharing identical ranges into
 * segments like { days: 'Mon–Fri', hours: '9:00 AM – 5:00 PM' }.
 */
export function summarizeWeek(week: WeekState): ScheduleSummarySegment[] {
  const segments: ScheduleSummarySegment[] = [];
  let runStart = -1;
  let runSignature = '';

  const flush = (endIndex: number): void => {
    if (runStart === -1) return;
    const startMeta = DAY_META[runStart];
    const endMeta = DAY_META[endIndex];
    const startRanges = week[runStart]?.ranges ?? [];
    if (!startMeta || !endMeta) return;
    const days = runStart === endIndex ? startMeta.short : `${startMeta.short}–${endMeta.short}`;
    segments.push({ days, hours: rangesLabel(startRanges) });
  };

  week.forEach((day, index) => {
    const active = day.enabled && day.ranges.length > 0;
    const signature = active ? rangesSignature(day.ranges) : '';
    if (active && signature === runSignature && runStart !== -1) {
      return; // extend current run
    }
    // Close any open run at the previous index.
    if (runStart !== -1) flush(index - 1);
    if (active) {
      runStart = index;
      runSignature = signature;
    } else {
      runStart = -1;
      runSignature = '';
    }
  });
  if (runStart !== -1) flush(week.length - 1);

  return segments;
}

// ── DST spring-forward conflict (non-blocking warning) ──────────────

/**
 * Returns the upcoming spring-forward gap if any enabled range on the transition's
 * weekday would land in it, else null. Warning only — never blocks saving.
 */
export function findDstConflict(
  week: WeekState,
  timezone: string,
  now: Date
): SpringForwardGap | null {
  const gap = getNextSpringForwardGap(timezone, now);
  if (!gap) return null;
  for (const [index, day] of week.entries()) {
    const meta = DAY_META[index];
    if (!day.enabled || !meta || meta.dayOfWeek !== gap.dayOfWeek) continue;
    for (const range of day.ranges) {
      const startMinutes = hhmmToMinutes(range.start);
      const endMinutes = hhmmToMinutes(range.end);
      if (startMinutes < gap.gapEndMinutes && endMinutes > gap.gapStartMinutes) {
        return gap;
      }
    }
  }
  return null;
}

/** '02:00 AM' style label for a gap minute-of-day. */
export function formatGapMinutes(minutes: number): string {
  return formatHhmm(minutesToHhmm(minutes));
}

/** Convenience: turn a full ScheduleData payload into editor week + settings. */
export function scheduleDataToState(data: ScheduleData): {
  week: WeekState;
  bookingSettings: BookingSettings;
  timezone: string;
} {
  return {
    week: rulesToWeek(data.rules),
    bookingSettings: data.bookingSettings,
    timezone: data.timezone,
  };
}
