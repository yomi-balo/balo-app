/**
 * BAL-236 — duration-pill derivation, the additive filter, the stale-filter reset predicate,
 * and the confirmation-step ladder clamp. PURE — no React.
 */
import {
  SLOT_DURATION_LADDER,
  type AvailabilitySlotDto,
  type SlotDurationMinutes,
} from '@balo/shared/availability';

export type DurationFilter = SlotDurationMinutes | 'any';

/** `[Any, ...distinct maxDuration values present on the day, ascending]`. The derived set is
 *  always a subset of `SLOT_DURATION_LADDER` because `maxDuration` is always a ladder member
 *  (D6 — resolves the ticket's fixed-vs-derived pill tension). */
export function derivePills(slotsForDay: readonly AvailabilitySlotDto[]): DurationFilter[] {
  // ⚠ GUARDED, NOT ASSERTED. `AvailabilitySlotDto.maxDuration` is typed `number` because it
  // arrives off the wire; `as SlotDurationMinutes[]` would launder an unvalidated value into a
  // narrow type and render a pill nothing can ever match.
  const distinct = Array.from(new Set(slotsForDay.map((s) => s.maxDuration)))
    .filter(isSlotDurationMinutes)
    .sort((a, b) => a - b);
  return ['any', ...distinct];
}

/** The one runtime check that `maxDuration` really is a ladder value. */
export function isSlotDurationMinutes(value: number): value is SlotDurationMinutes {
  return (SLOT_DURATION_LADDER as readonly number[]).includes(value);
}

/** Additive filter: `d` keeps every slot whose `maxDuration >= d`. `'any'` is the identity. */
export function filterSlotsByDuration(
  slotsForDay: readonly AvailabilitySlotDto[],
  filter: DurationFilter
): AvailabilitySlotDto[] {
  if (filter === 'any') return [...slotsForDay];
  return slotsForDay.filter((s) => s.maxDuration >= filter);
}

/** True when switching to `slotsForDay` would make the active filter match nothing — the
 *  trigger for the auto-reset-to-`'any'` + inline warning (never a blank list). `'any'` never
 *  needs a reset. */
export function shouldResetFilter(
  slotsForDay: readonly AvailabilitySlotDto[],
  activeFilter: DurationFilter
): boolean {
  if (activeFilter === 'any') return false;
  return !slotsForDay.some((s) => s.maxDuration >= activeFilter);
}

/** The confirmation step's duration options: the ladder, clamped to what the selected slot can
 *  actually hold. */
export function confirmationDurations(maxDuration: number): SlotDurationMinutes[] {
  return SLOT_DURATION_LADDER.filter((d) => d <= maxDuration);
}
