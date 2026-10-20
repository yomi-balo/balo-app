'use client';

import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { savedForLaterBody } from './funding/funding-copy';

export interface StepSavedForLaterProps {
  companyName: string | null;
  expertFirstName: string | null;
  /** Whether the typed details were kept on this device. */
  draftKept: boolean;
  onDone: () => void;
}

/**
 * The result of a member's "Save and finish later": nothing was booked and no time is held, and
 * the company's billing admins have been told. The typed fields wait on this device when a draft
 * was written.
 *
 * ⚠ UNCLEARED MJ CHECKPOINT (BAL-608 AC13): the copy lives in funding-copy.ts as placeholder.
 */
export function StepSavedForLater({
  companyName,
  expertFirstName,
  draftKept,
  onDone,
}: Readonly<StepSavedForLaterProps>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
      <span className="bg-primary/10 flex h-14 w-14 items-center justify-center rounded-full">
        <Bell className="text-primary h-6 w-6" aria-hidden="true" />
      </span>
      <div className="max-w-[360px] space-y-1.5">
        <h2 className="text-foreground text-lg font-semibold">Saved for later</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {savedForLaterBody(companyName, expertFirstName, draftKept)}
        </p>
        <p className="text-muted-foreground/80 text-[13px] leading-relaxed">
          The time isn&apos;t held, so you&apos;ll choose one when you come back.
        </p>
      </div>
      <Button className="min-h-11" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
