'use client';

import { MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ExpertAvailabilityCalendar,
  type AvailabilitySlotSelection,
} from '@/components/availability';

/**
 * BAL-400 Step 1 — embeds `ExpertAvailabilityCalendar` AS SHIPPED (D3). No internal state is
 * redesigned or wrapped; the one addition this design pass makes is populating `emptyAction`
 * for the `not_configured` / `no_slots` / `unavailable` branches with a "Message {Expert}
 * instead" escape, so "no availability" is never a dead end.
 */
export function StepPickTime({
  expertProfileId,
  expertFirstName,
  onSlotSelect,
  onMessage,
}: Readonly<{
  expertProfileId: string;
  expertFirstName: string | null;
  onSlotSelect: (selection: AvailabilitySlotSelection) => void;
  onMessage: () => void;
}>): React.JSX.Element {
  return (
    <div className="p-6">
      <ExpertAvailabilityCalendar
        expertProfileId={expertProfileId}
        mode="selectable"
        viewerType="client"
        onSlotSelect={onSlotSelect}
        emptyAction={
          <Button variant="outline" size="sm" onClick={onMessage} className="mt-2 gap-1.5">
            <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
            Message {expertFirstName ?? 'them'} instead
          </Button>
        }
      />
    </div>
  );
}
