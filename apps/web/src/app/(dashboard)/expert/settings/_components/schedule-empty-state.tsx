'use client';

import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ScheduleEmptyStateProps {
  /** Seeds Mon–Fri 9–5 and drops the expert into the editor. */
  onUseDefaults: () => void;
  /** Opens the editor with an empty week to set up from scratch. */
  onSetUp: () => void;
}

/**
 * Invitation-framed empty state (balo-ui-skill: keep-with-invitation). Leads with the
 * action — set your hours — never absence ("No hours yet"). Renders as the body of the
 * Availability card, so it carries no card chrome of its own.
 */
export function ScheduleEmptyState({
  onUseDefaults,
  onSetUp,
}: Readonly<ScheduleEmptyStateProps>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-foreground text-[15px] font-semibold">Set your weekly hours</h3>
        <p className="text-muted-foreground mt-1 max-w-md text-sm leading-relaxed">
          Tell clients when you&apos;re open to consultations. They book within these hours — and
          Balo hides anything you&apos;re already busy with on a connected calendar.
        </p>
      </div>

      <div className="border-border bg-muted/40 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-foreground flex items-center gap-2 text-sm font-medium">
            <Sparkles className="text-primary h-4 w-4" aria-hidden="true" />A common starting point
          </div>
          <p className="text-muted-foreground mt-1 text-[13px]">
            Weekday mornings and afternoons, 9:00 AM – 5:00 PM.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2.5">
          <Button type="button" onClick={onUseDefaults}>
            Use these hours
          </Button>
          <Button type="button" variant="outline" onClick={onSetUp}>
            Set them up myself
          </Button>
        </div>
      </div>
    </div>
  );
}
