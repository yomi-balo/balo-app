/**
 * Pure helpers for the picker's up-front length: which slots hold a length, which lengths and
 * days are on offer, the shorter-call offers, and the past-start drop. No React.
 */
import {
  SLOT_DURATION_LADDER,
  type AvailabilitySlotDto,
  type SlotDurationMinutes,
} from '@balo/shared/availability';

export interface SoonerOffer {
  /** UTC ISO-8601 start of the earliest slot that holds `minutes`. */
  start: string;
  minutes: SlotDurationMinutes;
}

/** The one runtime check that `maxDuration` really is a ladder value. */
export function isSlotDurationMinutes(value: number): value is SlotDurationMinutes {
  return (SLOT_DURATION_LADDER as readonly number[]).includes(value);
}

/** A slot holds a length when its contiguous free minutes reach it. */
export function fitsLength(
  slot: Pick<AvailabilitySlotDto, 'maxDuration'>,
  length: number
): boolean {
  return slot.maxDuration >= length;
}

/** The ladder values at least one slot in the window can hold. */
export function availableLengths(
  slots: readonly AvailabilitySlotDto[]
): ReadonlySet<SlotDurationMinutes> {
  return new Set(SLOT_DURATION_LADDER.filter((d) => slots.some((s) => fitsLength(s, d))));
}

/** The largest available ladder value at or below `preferred`. Lengths that fit form a prefix of
 *  the ladder, so this steps down, never up. With no slots at all it returns `preferred`. */
export function fallbackLength(
  preferred: SlotDurationMinutes,
  slots: readonly AvailabilitySlotDto[]
): SlotDurationMinutes {
  if (slots.length === 0) return preferred;
  const available = availableLengths(slots);
  const fitting = SLOT_DURATION_LADDER.filter((d) => d <= preferred && available.has(d));
  return fitting.at(-1) ?? preferred;
}

/**
 * The trade-off frontier for one day: for each length shorter than `length` (longest first), its
 * earliest start, kept only if it begins before every longer option kept so far (including the
 * first time at `length` itself). Earliest first, at most three.
 */
export function soonerOffers(
  daySlots: readonly AvailabilitySlotDto[],
  length: SlotDurationMinutes
): SoonerOffer[] {
  const firstAtLength = daySlots.find((s) => fitsLength(s, length));
  let cutoff = firstAtLength ? Date.parse(firstAtLength.start) : Infinity;
  const offers: SoonerOffer[] = [];
  for (const minutes of SLOT_DURATION_LADDER.filter((d) => d < length).reverse()) {
    const first = daySlots.find((s) => fitsLength(s, minutes));
    if (first && Date.parse(first.start) < cutoff) {
      offers.push({ start: first.start, minutes });
      cutoff = Date.parse(first.start);
    }
  }
  return offers.reverse();
}

/** Days with a time at `length`, and (unpinned only) days that only have shorter times. */
export function splitDaysByLength(
  slotsByDay: ReadonlyMap<string, readonly AvailabilitySlotDto[]>,
  length: SlotDurationMinutes,
  pinned: boolean
): { daysAtLength: Set<string>; daysShorterOnly: Set<string> } {
  const daysAtLength = new Set<string>();
  const daysShorterOnly = new Set<string>();
  for (const [dayKey, slots] of slotsByDay) {
    if (slots.some((s) => fitsLength(s, length))) daysAtLength.add(dayKey);
    else if (!pinned) daysShorterOnly.add(dayKey);
  }
  return { daysAtLength, daysShorterOnly };
}

/** The first day after `fromKey` that has a time at the length, or `null`. */
export function nextDayAtLength(
  sortedDayKeys: readonly string[],
  fromKey: string,
  daysAtLength: ReadonlySet<string>
): string | null {
  return sortedDayKeys.find((key) => key > fromKey && daysAtLength.has(key)) ?? null;
}

/** Slots that have not yet started. */
export function dropPastSlots(
  slots: readonly AvailabilitySlotDto[],
  now: Date
): AvailabilitySlotDto[] {
  const nowMs = now.getTime();
  return slots.filter((s) => Date.parse(s.start) > nowMs);
}
