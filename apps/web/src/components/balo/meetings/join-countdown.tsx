'use client';

import { useId } from 'react';
import { Clock } from 'lucide-react';
import { CASE_JOIN_WINDOW_MINUTES } from '@balo/shared/engagements';
import { Button } from '@/components/ui/button';

interface JoinCountdownProps {
  /** `joinCountdownLabel`'s output, e.g. "Join in 2 days" / "Join tomorrow" / "Join in 40 minutes". */
  readonly label: string;
}

/**
 * The JOIN slot before the window opens, occupying the same place and size `JoinMeetingButton`
 * will take over once it does. A DELIBERATE, NARROW exception to "an absent action beats a dead
 * one": this may render inactive only because it becomes active on its own and says when — never
 * copy this pattern for a control that stays permanently out of reach.
 *
 * ⚠ `aria-disabled`, NEVER `disabled` — "in 2 days" is information, so the control stays
 * focusable and legible (no opacity fade; the default button text colour already clears
 * 4.5:1). `JoinMeetingButton` itself keeps its "rendered ONLY inside the join window" invariant
 * untouched — this is a wholly separate element, not that component plus a prop.
 */
export function JoinCountdown({ label }: Readonly<JoinCountdownProps>): React.JSX.Element {
  const hintId = useId();
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-disabled="true"
        aria-describedby={hintId}
        onClick={(event) => event.preventDefault()}
        data-testid="join-countdown"
        className="min-h-11 px-4"
      >
        <Clock size={14} className="text-muted-foreground" aria-hidden="true" />
        {label}
      </Button>
      <span id={hintId} className="sr-only">
        Opens {CASE_JOIN_WINDOW_MINUTES} minutes before the start.
      </span>
    </>
  );
}
