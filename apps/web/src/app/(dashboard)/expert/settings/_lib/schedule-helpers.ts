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

/** Suffix appended to any end time that lands on the FOLLOWING calendar day. */
export const NEXT_DAY_SUFFIX = '(next day)';

// ── Time helpers ────────────────────────────────────────────────────

export function hhmmToMinutes(value: string): number {
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Wraps modularly rather than clamping — `1440` (midnight, one full day later) becomes
 * `'00:00'`, not `'23:45'`. Every caller in this module already pre-wraps its input
 * (`% MINUTES_PER_DAY`), so this is normally a no-op; making the function itself
 * modular means a future caller that forgets to pre-wrap gets the correct clock-face
 * answer instead of silently landing on 23:45.
 */
export function minutesToHhmm(minutes: number): string {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const mins = wrapped % 60;
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

// ── Crossing-midnight helpers ────────────────────────────────────────

/**
 * THE definition of "this range crosses midnight" for the whole editor. Everything
 * else derives from it — option building, validation, DST, analytics, the badge.
 * DO NOT write a second `end < start` anywhere in this feature.
 *
 * String compare is exact: both values come from the zero-padded 96-slot TIME_OPTIONS
 * set, so this is identical to comparing minutes — and identical to the resolver's own
 * `endTime < startTime` (apps/api/src/services/availability/resolver.ts).
 *
 * `start === end` is forbidden at four layers (DB CHECK, both Zod schemas, the picker)
 * and returns false here: it is a different error with its own message, not an
 * overnight range.
 */
export function isOvernightRange(range: Pick<TimeRange, 'start' | 'end'>): boolean {
  return range.end < range.start;
}

/** True when some OTHER range on this day already crosses midnight. */
export function dayHasOtherOvernightRange(day: DayState, rangeId: string): boolean {
  return day.ranges.some((range) => range.id !== rangeId && isOvernightRange(range));
}

/**
 * End-picker options for ONE range: every 15-minute slot except the range's own start.
 *   1. same-day slots strictly after `start`, through 23:45 — normal labels
 *   2. then wrapped slots 00:00 … < start — each suffixed `(next day)`
 *
 * `allowOvernight` is false when a SIBLING range on the same day already crosses
 * midnight (design §1: a day can hold only one). The wrapped half is then dropped and
 * the list reverts to today's shipped behaviour.
 *
 * The wrapped half is kept regardless when THIS range is already crossing — a Radix
 * Select whose current value is absent from its items renders an empty trigger.
 */
export function buildEndOptions(
  range: Pick<TimeRange, 'start' | 'end'>,
  allowOvernight: boolean
): readonly TimeOption[] {
  const sameDay = TIME_OPTIONS.filter((option) => option.value > range.start);
  if (!allowOvernight && !isOvernightRange(range)) return sameDay;
  const wrapped = TIME_OPTIONS.filter((option) => option.value < range.start).map((option) => ({
    value: option.value,
    label: `${option.label} ${NEXT_DAY_SUFFIX}`,
  }));
  return [...sameDay, ...wrapped];
}

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

/**
 * Default range appended when adding to a day: an hour after the previous range ends.
 * The START stays on the clock face; the END is allowed to WRAP past midnight (BAL-415)
 * rather than clamping to 23:45, which used to produce `start === end`.
 *
 * The preferred anchor can land INSIDE an existing range's own-day interval — most
 * notably a crossing range's `[start, 1440)` tail, which `defaultRange()` (09:00–17:00)
 * doesn't avoid either. So this walks every 15-minute boundary from the anchor,
 * wrapping once through the full day, until it finds an hour that genuinely doesn't
 * collide with anything already on the day. Only one range per day may cross midnight
 * (design §1), so once one already exists, a candidate that would itself cross is
 * skipped rather than handed to the expert unsaveable. Returns null when the day's free
 * space is genuinely exhausted — the caller is expected to no-op rather than add a
 * range it can't place.
 */
export function nextRangeDefault(existing: readonly TimeRange[]): TimeRange | null {
  const last = existing.at(-1);
  if (!last) return defaultRange();

  const hasOvernight = existing.some(isOvernightRange);
  // Own-day occupied minute-of-day intervals — a crossing range occupies through
  // midnight on ITS day; the tail belongs to the next day and is out of scope here.
  const occupied = existing.map((range) => ({
    start: hhmmToMinutes(range.start),
    end: effectiveEndMinutes(range),
  }));
  const overlapsOccupied = (start: number, end: number): boolean =>
    occupied.some((slot) => start < slot.end && end > slot.start);

  // Preferred anchor: an hour after the previous range ends, clamped so the START
  // stays representable today — the END is free to wrap, which is how a range crosses
  // midnight.
  const anchor = Math.min(hhmmToMinutes(last.end) + 60, MINUTES_PER_DAY - TIME_STEP_MINUTES);

  for (let step = 0; step < MINUTES_PER_DAY / TIME_STEP_MINUTES; step++) {
    const start = (anchor + step * TIME_STEP_MINUTES) % MINUTES_PER_DAY;
    const end = start + 60;
    const crosses = end > MINUTES_PER_DAY;
    if (crosses && hasOvernight) continue;
    if (overlapsOccupied(start, crosses ? MINUTES_PER_DAY : end)) continue;
    return { id: newRangeId(), start: minutesToHhmm(start), end: minutesToHhmm(end) };
  }

  return null;
}

// ── Week mutations (pure; keep the component's setWeek callbacks shallow) ─────

/** One 15-minute step later, wrapping 23:45 → 00:00 (never clamping). */
function bumpOneStep(hhmm: string): string {
  return minutesToHhmm((hhmmToMinutes(hhmm) + TIME_STEP_MINUTES) % MINUTES_PER_DAY);
}

function applyRangeChange(
  range: TimeRange,
  rangeId: string,
  field: 'start' | 'end',
  value: string
): TimeRange {
  if (range.id !== rangeId) return range;
  if (field === 'start') {
    // `start === end` is the one genuinely-invalid pairing (DB CHECK
    // avail_rules_start_ne_end_check). Every other pairing is legal: an end EARLIER
    // than the start simply means the range now crosses midnight, so the expert's
    // chosen end is left exactly where they put it and the row's badge says so.
    const end = value === range.end ? bumpOneStep(value) : range.end;
    return { ...range, start: value, end };
  }
  return { ...range, end: value };
}

/** Immutably update one range's start/end within a day. */
export function changeRangeInWeek(
  week: WeekState,
  dayIndex: number,
  rangeId: string,
  field: 'start' | 'end',
  value: string
): WeekState {
  return week.map((day, index) =>
    index === dayIndex
      ? {
          ...day,
          ranges: day.ranges.map((range) => applyRangeChange(range, rangeId, field, value)),
        }
      : day
  );
}

/** Immutably remove one range from a day; disable the day if it becomes empty. */
export function removeRangeFromWeek(week: WeekState, dayIndex: number, rangeId: string): WeekState {
  return week.map((day, index) => {
    if (index !== dayIndex) return day;
    const ranges = day.ranges.filter((range) => range.id !== rangeId);
    return { ...day, ranges, enabled: ranges.length > 0 && day.enabled };
  });
}

function cloneRangeWithNewId(range: TimeRange): TimeRange {
  return { ...range, id: newRangeId() };
}

/** Immutably copy one day's ranges (fresh ids) onto the target days, enabling them. */
export function copyDayRangesInWeek(
  week: WeekState,
  sourceIndex: number,
  targetIndices: number[]
): WeekState {
  const source = week[sourceIndex];
  if (!source) return week;
  const targets = new Set(targetIndices);
  return week.map((day, index) =>
    targets.has(index)
      ? { ...day, enabled: true, ranges: source.ranges.map(cloneRangeWithNewId) }
      : day
  );
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

export function hasOvernightWindow(week: WeekState): boolean {
  return week.some((day) => day.enabled && day.ranges.some(isOvernightRange));
}

/** Ranges ending strictly after this are "late". Module-private — analytics only. */
const LATE_WINDOW_AFTER_HHMM = '22:00';

/** Any enabled range ending after 22:00 WITHOUT crossing midnight. */
export function hasLateWindow(week: WeekState): boolean {
  return week.some(
    (day) =>
      day.enabled &&
      day.ranges.some((range) => !isOvernightRange(range) && range.end > LATE_WINDOW_AFTER_HHMM)
  );
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
  .refine((rule) => rule.startTime !== rule.endTime, {
    message: 'A range needs a different start and end time.',
  });

export const scheduleRulesSchema = z.array(scheduleRuleSchema).max(21);

// ── Conflict detection ────────────────────────────────────────────

/** Minutes-of-day at which a range stops occupying its OWN day (1440 when it crosses). */
function effectiveEndMinutes(range: TimeRange): number {
  return isOvernightRange(range) ? MINUTES_PER_DAY : hhmmToMinutes(range.end);
}

/**
 * '9:00 PM – 1:00 AM' or, for a range that crosses midnight, '9:00 PM – 1:00 AM (next
 * day)'. The ONE definition of the en-dash hours label — every conflict message and the
 * saved-summary route through this, so a crossing range is never rendered as though its
 * end were earlier in the same day.
 */
function hoursLabel(range: TimeRange): string {
  const base = `${formatHhmm(range.start)} – ${formatHhmm(range.end)}`;
  return isOvernightRange(range) ? `${base} ${NEXT_DAY_SUFFIX}` : base;
}

export type ScheduleConflictKind = 'same-day-overlap' | 'cross-day-overlap' | 'two-overnight';

export interface ScheduleConflict {
  kind: ScheduleConflictKind;
  /** DISPLAY index (0=Mon … 6=Sun) of the first implicated range's day. */
  dayIndex: number;
  rangeId: string;
  /** The colliding range. For 'cross-day-overlap' this day is `(dayIndex + 1) % 7`. */
  conflictDayIndex: number;
  conflictRangeId: string;
  /** Blocking toast copy — the full, two-day explanation. */
  message: string;
}

/** (a) two-overnight — a day can only hold one crossing range. */
function findTwoOvernightConflict(
  day: DayState,
  index: number,
  meta: DayMeta,
  nextMeta: DayMeta
): ScheduleConflict | null {
  const overnight = day.ranges.filter(isOvernightRange);
  if (overnight.length < 2) return null;
  const [first, second] = overnight;
  if (!first || !second) return null;
  return {
    kind: 'two-overnight',
    dayIndex: index,
    rangeId: first.id,
    conflictDayIndex: index,
    conflictRangeId: second.id,
    message:
      `${meta.full} already has one range that runs past midnight — ${hoursLabel(first)}. ` +
      `A day can only have one overnight range, since they'd both be running at the same ` +
      `time late that night. Remove one, or adjust the times so only one crosses into ${nextMeta.full}.`,
  };
}

/** (b) same-day-overlap — sort by start, walk holding the previous range. */
function findSameDayOverlapConflict(
  day: DayState,
  index: number,
  meta: DayMeta
): ScheduleConflict | null {
  const sorted = [...day.ranges].sort((a, b) => hhmmToMinutes(a.start) - hhmmToMinutes(b.start));
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const range = sorted[i];
    if (!previous || !range) continue;
    if (hhmmToMinutes(range.start) < effectiveEndMinutes(previous)) {
      return {
        kind: 'same-day-overlap',
        dayIndex: index,
        rangeId: previous.id,
        conflictDayIndex: index,
        conflictRangeId: range.id,
        message: `Time ranges on ${meta.full} overlap.`,
      };
    }
  }
  return null;
}

/** (c) cross-day-overlap — a crossing range's tail against the next day's ranges. */
function findCrossDayOverlapConflict(
  day: DayState,
  index: number,
  week: WeekState,
  meta: DayMeta,
  nextMeta: DayMeta
): ScheduleConflict | null {
  const nextDay = week[(index + 1) % week.length];
  if (!nextDay?.enabled) return null;
  for (const r of day.ranges) {
    if (!isOvernightRange(r)) continue;
    const tailEnd = hhmmToMinutes(r.end);
    for (const s of nextDay.ranges) {
      if (hhmmToMinutes(s.start) < tailEnd) {
        return {
          kind: 'cross-day-overlap',
          dayIndex: index,
          rangeId: r.id,
          conflictDayIndex: (index + 1) % week.length,
          conflictRangeId: s.id,
          message:
            `${meta.full}'s ${hoursLabel(r)} range runs into ${nextMeta.full} morning, overlapping the ` +
            `${hoursLabel(s)} range you already set for ${nextMeta.full}. Adjust one of the times so ` +
            `they don't overlap.`,
        };
      }
    }
  }
  return null;
}

/** First conflict in display order, or null. Pure. */
export function findScheduleConflict(week: WeekState): ScheduleConflict | null {
  for (const [index, day] of week.entries()) {
    if (!day.enabled) continue;
    const meta = DAY_META[index];
    const nextMeta = DAY_META[(index + 1) % DAY_META.length];
    if (!meta || !nextMeta) continue;

    const conflict =
      findTwoOvernightConflict(day, index, meta, nextMeta) ??
      findSameDayOverlapConflict(day, index, meta) ??
      findCrossDayOverlapConflict(day, index, week, meta, nextMeta);
    if (conflict) return conflict;
  }
  return null;
}

/**
 * rangeId → the short inline pointer rendered under that row's range. Derived from the
 * SAME ScheduleConflict that produced the toast, so the two can never disagree.
 * Ranges that have since been edited away are simply omitted.
 */
export function conflictInlineMessages(
  conflict: ScheduleConflict,
  week: WeekState
): Readonly<Record<string, string>> {
  const day = week[conflict.dayIndex];
  const conflictDay = week[conflict.conflictDayIndex];
  const range = day?.ranges.find((r) => r.id === conflict.rangeId);
  const other = conflictDay?.ranges.find((r) => r.id === conflict.conflictRangeId);
  if (!range || !other) return {};

  if (conflict.kind === 'two-overnight') {
    const message = 'Only one range per day can run past midnight.';
    return { [range.id]: message, [other.id]: message };
  }

  if (conflict.kind === 'cross-day-overlap') {
    const otherMeta = DAY_META[conflict.conflictDayIndex];
    const rangeMeta = DAY_META[conflict.dayIndex];
    if (!otherMeta || !rangeMeta) return {};
    return {
      [range.id]: `Overlaps with ${otherMeta.full}'s ${hoursLabel(other)} range.`,
      [other.id]: `Overlaps with ${rangeMeta.full}'s ${hoursLabel(range)} range.`,
    };
  }

  // same-day-overlap
  return {
    [range.id]: `Overlaps with your ${hoursLabel(other)} range on the same day.`,
    [other.id]: `Overlaps with your ${hoursLabel(range)} range on the same day.`,
  };
}

export interface ScheduleValidation {
  /** Blocking toast copy. */
  message: string;
  /**
   * The conflict `message` narrates, so the row highlight can only ever describe the
   * error actually shown in the toast. Null for the empty-day and zod-schema failure
   * paths, which don't (and can't) implicate a `ScheduleConflict` pair.
   */
  conflict: ScheduleConflict | null;
}

/**
 * Validates the editor week in ONE evaluation. Returns null when valid, else the
 * message plus (only when applicable) the conflict it describes. Checks run in this
 * order: empty enabled day, then `findScheduleConflict`, then the shared zod rule
 * schema — the FIRST one to fail wins, and it is the only thing reported. Calling this
 * exactly once per save (instead of `findScheduleConflict` once for the toast and again
 * inside a separate validation pass) is what keeps the toast and the row highlight from
 * ever disagreeing.
 */
export function evaluateWeek(week: WeekState): ScheduleValidation | null {
  for (const [index, day] of week.entries()) {
    const meta = DAY_META[index];
    if (!day.enabled || !meta) continue;
    if (day.ranges.length === 0) {
      return { message: `Add hours to ${meta.full}, or turn the day off.`, conflict: null };
    }
  }
  const conflict = findScheduleConflict(week);
  if (conflict) return { message: conflict.message, conflict };

  const parsed = scheduleRulesSchema.safeParse(weekToRules(week));
  if (!parsed.success) {
    return {
      message: parsed.error.issues[0]?.message ?? 'Please review your schedule.',
      conflict: null,
    };
  }
  return null;
}

/** Message-only view of `evaluateWeek`, for callers that don't need the row highlight. */
export function validateWeek(week: WeekState): string | null {
  return evaluateWeek(week)?.message ?? null;
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

function rangesLabel(ranges: readonly TimeRange[]): string {
  return ranges.map((range) => hoursLabel(range)).join(', ');
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

export interface DstGapMatch {
  /** True when the matched interval is the TAIL of an overnight range set the PREVIOUS day. */
  isOvernightTail: boolean;
  /** DISPLAY index (0=Mon … 6=Sun) of the day the matched range was AUTHORED on. */
  sourceDayIndex: number;
}

/** Half-open overlap test, shared by both the front-half and tail checks below. */
function intervalHitsGap(startMinutes: number, endMinutes: number, gap: SpringForwardGap): boolean {
  return startMinutes < gap.gapEndMinutes && endMinutes > gap.gapStartMinutes;
}

/**
 * Which enabled interval, if any, lands in the spring-forward gap. Pure, Intl-free —
 * takes an already-computed `gap` so the cheap per-keystroke check runs WITHOUT
 * re-paying the expensive `getNextSpringForwardGap` scan (which depends only on the
 * timezone). A crossing range contributes TWO intervals on two different calendar
 * days — `[start, 1440)` on its own day and `[0, end)` on the next — so a gap can
 * land in either the front half or the overnight tail.
 */
/** Gap match for a single range against a single day's meta. Extracted to keep the
 * outer scan's own cognitive complexity within the SonarCloud limit. */
function rangeGapMatch(
  range: TimeRange,
  index: number,
  meta: DayMeta,
  nextMeta: DayMeta,
  gap: SpringForwardGap
): DstGapMatch | null {
  if (!isOvernightRange(range)) {
    if (
      meta.dayOfWeek === gap.dayOfWeek &&
      intervalHitsGap(hhmmToMinutes(range.start), hhmmToMinutes(range.end), gap)
    ) {
      return { isOvernightTail: false, sourceDayIndex: index };
    }
    return null;
  }
  // Crossing range: front half on this day, tail on the next.
  if (
    meta.dayOfWeek === gap.dayOfWeek &&
    intervalHitsGap(hhmmToMinutes(range.start), MINUTES_PER_DAY, gap)
  ) {
    return { isOvernightTail: false, sourceDayIndex: index };
  }
  if (nextMeta.dayOfWeek === gap.dayOfWeek && intervalHitsGap(0, hhmmToMinutes(range.end), gap)) {
    return { isOvernightTail: true, sourceDayIndex: index };
  }
  return null;
}

export function findWeekGapMatch(week: WeekState, gap: SpringForwardGap): DstGapMatch | null {
  for (const [index, day] of week.entries()) {
    if (!day.enabled) continue;
    const meta = DAY_META[index];
    const nextMeta = DAY_META[(index + 1) % DAY_META.length];
    if (!meta || !nextMeta) continue;

    for (const range of day.ranges) {
      const match = rangeGapMatch(range, index, meta, nextMeta, gap);
      if (match) return match;
    }
  }
  return null;
}

// Re-exported so the editor can run the expensive scan and the cheap overlap test
// on separate memo keys (scan on timezone, overlap on the week).
export { getNextSpringForwardGap };

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
