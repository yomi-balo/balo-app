'use client';

import { useCallback } from 'react';
import { Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track, CALL_NOW_EVENTS } from '@/lib/analytics';
import { callNowPresence } from '@/lib/call-now/call-now-presence';
import { CALL_NOW_COPY } from '@/lib/call-now/call-now-copy';
import type { CaseCallNowView } from '@/lib/call-now/call-now-types';
import { useCallNowSurface } from '@/lib/call-now/use-call-now-surface';

/**
 * BAL-651 — the party card's Call now entry. Renders from the loader's `CaseCallNowView` alone:
 * the api decided whether the viewer can call, and this only shows the action or the one quiet
 * line that explains why not. It never re-derives availability.
 *
 * ⚠ A SINGLE LINE, NOT A DISABLED BUTTON. A button the viewer cannot press reads as broken;
 * "Sam is in another call" says why and what to do instead.
 */

interface CallNowEntryProps {
  callNow: CaseCallNowView;
  /** Which side is looking, for the click event. Presentation only. */
  lens: 'client' | 'expert';
  /** Opens the confirm with the attempt id minted by this tap, so every later event joins to it. */
  onCallNow: (attemptId: string) => void;
}

/** The callee's local time, `null` when the zone is absent or not one the runtime knows. */
function formatCalleeTime(timeZone: string | null): string | null {
  if (timeZone === null) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(new Date());
  } catch {
    return null;
  }
}

function QuietLine({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <p
      className="text-muted-foreground mt-3 border-t pt-3 text-center text-xs"
      suppressHydrationWarning
    >
      {children}
    </p>
  );
}

export function CallNowEntry({
  callNow,
  lens,
  onCallNow,
}: Readonly<CallNowEntryProps>): React.JSX.Element | null {
  const { confirm } = callNow;
  const surface = useCallNowSurface();
  const handleClick = useCallback(() => {
    const attemptId = crypto.randomUUID();
    track(CALL_NOW_EVENTS.CLICKED, {
      attempt_id: attemptId,
      lens,
      callee_presence: callNowPresence(callNow),
      has_booking_today: confirm?.kind === 'client_terms' && confirm.inPlaceCandidate !== null,
      surface,
      entry: 'party_card',
    });
    onCallNow(attemptId);
  }, [lens, callNow, confirm, surface, onCallNow]);

  if (callNow.entry === 'busy') {
    return <QuietLine>{CALL_NOW_COPY.busy(callNow.calleeLabel)}</QuietLine>;
  }

  if (callNow.entry === 'outside_hours') {
    const time = formatCalleeTime(callNow.calleeTimeZone);
    if (time === null) return null;
    return <QuietLine>{CALL_NOW_COPY.lateNight(callNow.calleeLabel, time)}</QuietLine>;
  }

  return (
    <div className="mt-3 border-t pt-3">
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full gap-2"
        aria-label={CALL_NOW_COPY.entryAriaLabel(callNow.calleeLabel)}
        onClick={handleClick}
      >
        <Phone className="size-4" aria-hidden="true" />
        {CALL_NOW_COPY.entry}
      </Button>
    </div>
  );
}
