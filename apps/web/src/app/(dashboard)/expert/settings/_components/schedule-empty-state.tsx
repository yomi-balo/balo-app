'use client';

import { Clock, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconBadge } from '@/components/balo/icon-badge';

interface ScheduleEmptyStateProps {
  /** Seeds Mon–Fri 9–5 and drops the expert into the editor. */
  onUseDefaults: () => void;
  /** Opens the editor with an empty week to set up from scratch. */
  onSetUp: () => void;
}

/**
 * Invitation-framed empty state (balo-ui-skill: keep-with-invitation). Leads with the
 * action — set your hours — never absence ("No hours yet").
 */
export function ScheduleEmptyState({
  onUseDefaults,
  onSetUp,
}: Readonly<ScheduleEmptyStateProps>): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-xl border p-8 text-center sm:p-10">
      <div className="mb-4 flex justify-center">
        <IconBadge icon={Clock} color="#2563EB" size={56} iconSize={26} />
      </div>
      <h2 className="text-foreground text-lg font-semibold">Set your weekly hours</h2>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm leading-relaxed">
        Tell clients when you&apos;re open to consultations. They book within these hours — and Balo
        hides anything you&apos;re already busy with on a connected calendar.
      </p>

      <div className="border-border bg-muted/40 mx-auto mt-6 max-w-sm rounded-xl border p-4">
        <div className="text-foreground flex items-center justify-center gap-2 text-sm font-medium">
          <Sparkles className="text-primary h-4 w-4" aria-hidden="true" />A common starting point
        </div>
        <p className="text-muted-foreground mt-1.5 mb-4 text-sm">
          Weekday mornings and afternoons, 9:00 AM – 5:00 PM.
        </p>
        <div className="flex flex-wrap justify-center gap-2.5">
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
