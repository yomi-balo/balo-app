'use client';

import type { AvailabilityScope } from '@balo/shared/availability';
import Link from 'next/link';
import { MessageCircle, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ExpertAvailabilityCalendar,
  type AvailabilitySlotSelection,
} from '@/components/availability';

function MessageInsteadButton({
  expertFirstName,
  onMessage,
}: Readonly<{ expertFirstName: string | null; onMessage: () => void }>): React.JSX.Element {
  return (
    <Button variant="outline" size="sm" onClick={onMessage} className="mt-2 gap-1.5">
      <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
      Message {expertFirstName ?? 'them'} instead
    </Button>
  );
}

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
  scope,
  similarExpertsHref,
}: Readonly<{
  expertProfileId: string;
  expertFirstName: string | null;
  onSlotSelect: (selection: AvailabilitySlotSelection) => void;
  onMessage: () => void;
  /** Forwarded to the calendar. Omit for a fresh consultation (`new_work`). */
  scope?: AvailabilityScope;
  /** When set, a paused expert's state leads with "Find a similar expert". */
  similarExpertsHref?: string;
}>): React.JSX.Element {
  return (
    <div className="p-6">
      <ExpertAvailabilityCalendar
        expertProfileId={expertProfileId}
        mode="selectable"
        viewerType="client"
        scope={scope}
        onSlotSelect={onSlotSelect}
        pausedAction={
          <>
            {similarExpertsHref !== undefined && (
              <Button asChild size="sm" className="mt-4 gap-1.5">
                <Link href={similarExpertsHref}>
                  <Search className="h-3.5 w-3.5" aria-hidden="true" />
                  Find a similar expert
                </Link>
              </Button>
            )}
            <MessageInsteadButton expertFirstName={expertFirstName} onMessage={onMessage} />
          </>
        }
        emptyAction={
          <MessageInsteadButton expertFirstName={expertFirstName} onMessage={onMessage} />
        }
      />
    </div>
  );
}
