/**
 * PURE availability plan generator for BAL-239.
 *
 * Produces, per expert, the availability_rules + consultations to insert and an
 * in-memory `busyBlocks` fixture to feed the BAL-243 resolver. No DB, no
 * resolver call (the impure orchestrator commits rows then runs the resolver).
 *
 * Archetypes are assigned DETERMINISTICALLY by expert index (not random) so the
 * distribution is exact and reproducible for any `count`. The cancelled-slot
 * edge case is pinned to a designated expert for a unit assertion.
 *
 * Times in rules are LOCAL wall-clock in the expert's timezone (Postgres
 * `time`); busy blocks are UTC instants (normalized vendor free/busy).
 */
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { ARCHETYPE_THRESHOLDS, DEFAULT_WINDOW } from './constants.js';
import { WeightedRng } from './rng.js';
import type { Archetype, AvailabilityPlan, NewConsultationSeed, NewRuleSeed } from './types.js';
import type { BusyBlock } from '../availability/types.js';

export interface GenerateAvailabilityInput {
  experts: { id: string; index: number; timezone: string }[];
  seed: number;
  baselineNow: Date;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HORIZON_MS = 14 * DAY_MS;
const WEEK_MS = 7 * DAY_MS;
const WEEKDAYS = [1, 2, 3, 4, 5];

/** Deterministic archetype for an expert at `index` of a `count`-sized run. */
export function archetypeForIndex(index: number, count: number): Archetype {
  const pct = Math.floor((index / count) * 100);
  for (const { archetype, upTo } of ARCHETYPE_THRESHOLDS) {
    if (pct < upTo) return archetype;
  }
  return 'BOOKED_SOLID';
}

export function generateAvailabilityPlan(input: GenerateAvailabilityInput): AvailabilityPlan[] {
  const { experts, seed, baselineNow } = input;
  const count = experts.length;
  // Derive a per-expert RNG from the seed + index so plans are stable whether
  // an expert is processed alone (refresh-only) or in a batch.
  const plans: AvailabilityPlan[] = [];

  // The first SPARSE expert carries the booked-then-cancelled edge case.
  const firstSparseIndex = experts.find(
    (e) => archetypeForIndex(e.index, count) === 'SPARSE'
  )?.index;

  // The first WIDE_OPEN expert carries a CONFIRMED consultation deliberately
  // placed INSIDE one of its rule windows (in the expert's tz). This guarantees
  // the resolver provably trims that window and shifts earliest_available_at, so
  // the consultation-subtraction path visibly affects the cache (BAL-239 ticket
  // requirement). WIDE_OPEN is chosen because its windows are wide and its busy
  // blocks are empty, so the trim is unambiguous.
  const firstWideOpenIndex = experts.find(
    (e) => archetypeForIndex(e.index, count) === 'WIDE_OPEN'
  )?.index;

  for (const expert of experts) {
    const archetype = archetypeForIndex(expert.index, count);
    const rng = new WeightedRng(seed + expert.index * 1000 + 7);
    const carriesCancelled = expert.index === firstSparseIndex;
    const carriesWindowAligned = expert.index === firstWideOpenIndex;

    const built = buildForArchetype({
      archetype,
      timezone: expert.timezone,
      baselineNow,
      rng,
      carriesCancelled,
      carriesWindowAligned,
    });

    plans.push({
      expertProfileId: expert.id,
      index: expert.index,
      archetype,
      rules: built.rules,
      busyBlocks: built.busyBlocks,
      consultations: built.consultations,
    });
  }

  return plans;
}

interface BuildArgs {
  archetype: Archetype;
  timezone: string;
  baselineNow: Date;
  rng: WeightedRng;
  carriesCancelled: boolean;
  /** When true, emit a confirmed consult aligned to a rule window (see caller). */
  carriesWindowAligned: boolean;
}

interface BuildResult {
  rules: NewRuleSeed[];
  busyBlocks: BusyBlock[];
  consultations: NewConsultationSeed[];
}

function buildForArchetype(args: BuildArgs): BuildResult {
  switch (args.archetype) {
    case 'WIDE_OPEN':
      return buildWideOpen(args);
    case 'SPARSE':
      return buildSparse(args);
    case 'NEXT_WEEK':
      return buildNextWeek(args);
    case 'TODAY_ONLY':
      return buildTodayOnly(args);
    case 'BOOKED_SOLID':
      return buildBookedSolid(args);
    default:
      return { rules: [], busyBlocks: [], consultations: [] };
  }
}

function weekdayRules(start: string, end: string): NewRuleSeed[] {
  return WEEKDAYS.map((dow) => ({ dayOfWeek: dow, startTime: start, endTime: end }));
}

/** Mon–Fri 09:00–17:00, no busy, optionally a confirmed consult inside a window. */
function buildWideOpen(args: BuildArgs): BuildResult {
  const rules = weekdayRules(DEFAULT_WINDOW.start, DEFAULT_WINDOW.end);
  const consultations: NewConsultationSeed[] = [];

  if (args.carriesWindowAligned) {
    // Designated WIDE_OPEN expert: place a confirmed consult at the START of a
    // rule window (in the expert's tz) so the resolver provably trims the
    // leading hour and earliest_available_at moves forward by exactly that hour
    // (e.g. 09:00 → 10:00 local). Anchored to the first rule's dayOfWeek at its
    // local start_time, converted to UTC the same way the resolver expands
    // rules (offset 0 = flush to the window start, which is what shifts earliest).
    const anchor = rules[0];
    const slotStart = ruleWindowSlot(args.baselineNow, anchor, args.timezone, 0);
    consultations.push({
      startAt: slotStart,
      endAt: new Date(slotStart.getTime() + HOUR_MS),
      status: 'confirmed',
    });
  } else if (args.rng.bool(0.4)) {
    // Other WIDE_OPEN experts: an arbitrary-UTC consult a few days out (does not
    // need to land inside a window — it's just realistic noise).
    const start = utcSlotDaysAhead(args.baselineNow, args.rng.int(2, 6), 12);
    consultations.push({
      startAt: start,
      endAt: new Date(start.getTime() + HOUR_MS),
      status: 'confirmed',
    });
  }
  return { rules, busyBlocks: [], consultations };
}

/** 2–3 short weekday windows, light busy blocks, sometimes the cancelled case. */
function buildSparse(args: BuildArgs): BuildResult {
  const rules: NewRuleSeed[] = [
    { dayOfWeek: 2, startTime: '10:00', endTime: '13:00' },
    { dayOfWeek: 4, startTime: '14:00', endTime: '17:00' },
  ];
  if (args.rng.bool(0.5)) {
    rules.push({ dayOfWeek: 1, startTime: '09:00', endTime: '11:00' });
  }

  const busyBlocks: BusyBlock[] = [];
  const consultations: NewConsultationSeed[] = [];

  // A light busy block tomorrow morning (UTC instant).
  const busyStart = floorToHour(new Date(args.baselineNow.getTime() + DAY_MS));
  busyBlocks.push({ startAt: busyStart, endAt: new Date(busyStart.getTime() + HOUR_MS) });

  if (args.carriesCancelled) {
    // Booked-then-cancelled over the SAME slot: one confirmed, one cancelled.
    // The resolver ignores the cancelled row, so this must not reduce
    // availability — asserted in availability-generator.test.ts.
    const slotStart = utcSlotDaysAhead(args.baselineNow, 3, 11);
    const slotEnd = new Date(slotStart.getTime() + HOUR_MS);
    consultations.push(
      { startAt: slotStart, endAt: slotEnd, status: 'confirmed' },
      { startAt: slotStart, endAt: slotEnd, status: 'cancelled' }
    );
  } else if (args.rng.bool(0.4)) {
    const start = utcSlotDaysAhead(args.baselineNow, args.rng.int(2, 5), 15);
    consultations.push({
      startAt: start,
      endAt: new Date(start.getTime() + HOUR_MS),
      status: 'confirmed',
    });
  }

  return { rules, busyBlocks, consultations };
}

/** Weekday rules + busy blocks tiling [baseline, baseline+7d] → earliest next week. */
function buildNextWeek(args: BuildArgs): BuildResult {
  const rules = weekdayRules(DEFAULT_WINDOW.start, DEFAULT_WINDOW.end);
  // One big busy block from baseline through +7d covers all of next-7-days'
  // windows, so the earliest free slot lands in the following week.
  const busyBlocks: BusyBlock[] = [
    {
      startAt: new Date(args.baselineNow),
      endAt: new Date(args.baselineNow.getTime() + WEEK_MS),
    },
  ];
  return { rules, busyBlocks, consultations: [] };
}

/** A single rule on baseline's LOCAL weekday, a couple hours after local now. */
function buildTodayOnly(args: BuildArgs): BuildResult {
  const local = toZonedTime(args.baselineNow, args.timezone);
  const dayOfWeek = local.getDay();
  let startHour = local.getHours() + 2;
  // Keep the window inside the same local day; if it's late, give a small one.
  if (startHour > 21) startHour = 21;
  const endHour = Math.min(startHour + 3, 23);
  const rules: NewRuleSeed[] = [
    {
      dayOfWeek,
      startTime: `${pad2(startHour)}:00`,
      endTime: `${pad2(endHour)}:00`,
    },
  ];
  return { rules, busyBlocks: [], consultations: [] };
}

/** Full weekday rules BUT busy blocks tile the entire horizon → earliest null. */
function buildBookedSolid(args: BuildArgs): BuildResult {
  const rules = weekdayRules(DEFAULT_WINDOW.start, DEFAULT_WINDOW.end);
  // One busy block spanning [baseline, baseline + horizon] removes everything.
  const busyBlocks: BusyBlock[] = [
    {
      startAt: new Date(args.baselineNow),
      endAt: new Date(args.baselineNow.getTime() + HORIZON_MS + DAY_MS),
    },
  ];
  const consultations: NewConsultationSeed[] = [];
  if (args.rng.bool(0.5)) {
    const start = utcSlotDaysAhead(args.baselineNow, 2, 10);
    consultations.push({
      startAt: start,
      endAt: new Date(start.getTime() + HOUR_MS),
      status: 'confirmed',
    });
  }
  return { rules, busyBlocks, consultations };
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * A UTC instant `daysAhead` days after baseline, snapped to `hourUtc:00`. Used
 * for arbitrary "realistic noise" consultation slots that do NOT need to land
 * inside a rule window — kept in UTC since consultations store instants. (Such
 * slots usually fall outside the local rule windows, so the resolver subtracts
 * nothing from them; that's intentional.)
 */
function utcSlotDaysAhead(baseline: Date, daysAhead: number, hourUtc: number): Date {
  const d = new Date(baseline.getTime() + daysAhead * DAY_MS);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

/**
 * Compute a UTC instant that lands INSIDE a rule window. Takes the next
 * occurrence (on/after baseline) of the rule's `dayOfWeek` at its local
 * `startTime` in the expert's IANA tz, adds `offsetHours` so the slot sits
 * strictly inside the window, and converts to a UTC instant via `fromZonedTime`
 * — exactly how the resolver expands rules (so the resolver provably trims it).
 */
function ruleWindowSlot(
  baseline: Date,
  rule: NewRuleSeed,
  timezone: string,
  offsetHours: number
): Date {
  // Walk forward day-by-day in the expert's local calendar until we hit the
  // rule's dayOfWeek on/after the baseline's local date.
  const localCursor = toZonedTime(baseline, timezone);
  localCursor.setHours(0, 0, 0, 0);
  for (let i = 0; i < 14; i++) {
    if (localCursor.getDay() === rule.dayOfWeek) break;
    localCursor.setDate(localCursor.getDate() + 1);
  }

  const yyyy = localCursor.getFullYear().toString().padStart(4, '0');
  const mm = (localCursor.getMonth() + 1).toString().padStart(2, '0');
  const dd = localCursor.getDate().toString().padStart(2, '0');

  // Apply the in-window offset to the rule's local start hour.
  const [startHour, startMin] = rule.startTime.split(':').map((s) => Number.parseInt(s, 10));
  const localHour = (startHour ?? 0) + offsetHours;
  const hh = localHour.toString().padStart(2, '0');
  const min = (startMin ?? 0).toString().padStart(2, '0');

  return fromZonedTime(`${yyyy}-${mm}-${dd}T${hh}:${min}:00`, timezone);
}

function floorToHour(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCMinutes(0, 0, 0);
  return copy;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
