'use client';

import { useEffect, useState } from 'react';
import type { AvailabilitySlotDto, SlotDurationMinutes } from '@balo/shared/availability';
import { DEFAULT_AVAILABILITY_WINDOW_DAYS } from '@balo/shared/availability';
import {
  useExpertAvailability,
  type AvailabilityView,
} from '@/components/availability/use-expert-availability';
import { dropPastSlots } from '@/components/availability/availability-filters';
import { useNowTick } from '@/components/availability/use-now-tick';
import { suggestTimes } from './suggest-times';

export type SuggestedTimesPickerView = 'suggested' | 'calendar' | null;

export interface SuggestedTimesPicker {
  availabilityView: AvailabilityView;
  suggestions: AvailabilitySlotDto[];
  pickerView: SuggestedTimesPickerView;
  setPickerView: (view: SuggestedTimesPickerView) => void;
  /** Re-fetches availability. Callers use this on `slot_unavailable` — the calendar's own
   *  `pickerKey` remount re-fetches on the SAME retry, but the suggestion list is fed by this
   *  hook's own `availabilityView` and would otherwise keep re-offering the just-taken slot. */
  reload: () => void;
}

/**
 * The suggested-first view's shared wiring, factored out of `RescheduleDialog` and
 * `ProposeTimesDialog` — both fetch availability the same way (`useExpertAvailability`, the
 * party card's quick-pick hook, no new endpoint), narrow it to slots long enough for the pin,
 * and decide ONCE whether step 1 opens on the suggestions or the calendar, staying `null` (a
 * loading skeleton at the call site) until that first decision lands. The two callers differ
 * only in what else they filter OUT of the candidate pool — `ProposeTimesDialog` also drops any
 * day already in its own picked list — which `extraFilter` covers without this hook needing to
 * know why.
 */
export function useSuggestedTimesPicker(params: {
  expertProfileId: string;
  fixedDurationMinutes: SlotDurationMinutes | undefined;
  originalStartIso: string;
  extraFilter?: (slot: AvailabilitySlotDto) => boolean;
}): SuggestedTimesPicker {
  const { expertProfileId, fixedDurationMinutes, originalStartIso, extraFilter } = params;
  const { view: availabilityView, reload } = useExpertAvailability(
    expertProfileId,
    DEFAULT_AVAILABILITY_WINDOW_DAYS,
    // Reschedules serve work already in flight, so a paused expert still has a real grid.
    'existing_work'
  );
  const now = useNowTick();
  const suggestions =
    fixedDurationMinutes !== undefined && availabilityView.kind === 'ready'
      ? suggestTimes(
          dropPastSlots(availabilityView.slots, now).filter(
            (slot) => slot.maxDuration >= fixedDurationMinutes && (extraFilter?.(slot) ?? true)
          ),
          originalStartIso
        )
      : [];

  const [chosenView, setPickerView] = useState<SuggestedTimesPickerView>(null);
  useEffect(() => {
    if (chosenView !== null || availabilityView.kind === 'loading') return;
    setPickerView(suggestions.length > 0 ? 'suggested' : 'calendar');
  }, [chosenView, availabilityView.kind, suggestions.length]);
  // Reactive, unlike the initial decision: suggestions can run out while the dialog is open (a
  // start passing, a background refresh, the last suggested day picked), and the calendar then
  // takes over rather than leaving a "Suggested times" heading over nothing.
  const pickerView =
    chosenView === 'suggested' && suggestions.length === 0 ? 'calendar' : chosenView;

  return { availabilityView, suggestions, pickerView, setPickerView, reload };
}
