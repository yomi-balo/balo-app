'use client';

import { useEffect, useState } from 'react';
import type { AvailabilitySlotDto, SlotDurationMinutes } from '@balo/shared/availability';
import { DEFAULT_AVAILABILITY_WINDOW_DAYS } from '@balo/shared/availability';
import {
  useExpertAvailability,
  type AvailabilityView,
} from '@/components/availability/use-expert-availability';
import { suggestTimes } from './suggest-times';

export type SuggestedTimesPickerView = 'suggested' | 'calendar' | null;

export interface SuggestedTimesPicker {
  availabilityView: AvailabilityView;
  suggestions: AvailabilitySlotDto[];
  pickerView: SuggestedTimesPickerView;
  setPickerView: (view: SuggestedTimesPickerView) => void;
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
  const { view: availabilityView } = useExpertAvailability(
    expertProfileId,
    DEFAULT_AVAILABILITY_WINDOW_DAYS
  );
  const suggestions =
    fixedDurationMinutes !== undefined && availabilityView.kind === 'ready'
      ? suggestTimes(
          availabilityView.slots.filter(
            (slot) => slot.maxDuration >= fixedDurationMinutes && (extraFilter?.(slot) ?? true)
          ),
          originalStartIso
        )
      : [];

  const [pickerView, setPickerView] = useState<SuggestedTimesPickerView>(null);
  useEffect(() => {
    if (pickerView !== null || availabilityView.kind === 'loading') return;
    setPickerView(suggestions.length > 0 ? 'suggested' : 'calendar');
  }, [pickerView, availabilityView.kind, suggestions.length]);

  return { availabilityView, suggestions, pickerView, setPickerView };
}
