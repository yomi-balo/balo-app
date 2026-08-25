'use client';

import { CalendarPlus, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatSlotDateTime } from '../format';
import { downloadIcsEvent } from '../ics';

export interface StepBookedIntroCallProps {
  expertFirstName: string | null;
  startIso: string;
  viewerTimezone: string;
  durationMinutes: number;
  /** `false` ⇒ the Daily room did not come up yet — no live join link is shown. */
  provisioned: boolean;
  joinPath: string;
  guestsInvited: number;
  guestInviteFailed: boolean;
  onDone: () => void;
}

/**
 * BAL-283 Step 3 — same visual shell as `StepBooked` (success ring, no confetti — a free
 * 15–30 min intro call is a smaller win than a paid consultation booking), call-shaped copy
 * instead of case-shaped. No "View case" (there is no case) — "Back to conversation" instead.
 */
export function StepBookedIntroCall({
  expertFirstName,
  startIso,
  viewerTimezone,
  durationMinutes,
  provisioned,
  joinPath,
  guestsInvited,
  guestInviteFailed,
  onDone,
}: Readonly<StepBookedIntroCallProps>): React.JSX.Element {
  const name = expertFirstName ?? 'them';
  const when = formatSlotDateTime(startIso, viewerTimezone);

  function handleAddToCalendar(): void {
    downloadIcsEvent({
      summary: `Intro call with ${name}`,
      startIso,
      durationMinutes,
      filename: 'intro-call.ics',
    });
  }

  return (
    <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
      <span className="bg-success/15 border-success/30 flex h-14 w-14 items-center justify-center rounded-full border shadow-[0_8px_24px_-4px_rgba(34,197,94,0.35)]">
        <Check className="text-success h-6 w-6" aria-hidden="true" />
      </span>
      <div className="max-w-[360px] space-y-1.5">
        <h2 className="text-foreground text-lg font-semibold">You&apos;re booked!</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {when} · Intro call with {name}.
        </p>
        {/* Same D2a non-negotiable honesty rule as `StepBooked`: no repair sweep, no retry job
            and no provision-on-join exists — this branch may state only what is TRUE. */}
        <p className="text-muted-foreground text-sm leading-relaxed">
          {provisioned
            ? 'The join link is on its way to your email.'
            : "Your time is held, but your call room isn't ready yet — our team has been alerted."}
        </p>
        {guestsInvited > 0 && (
          <p className="text-muted-foreground text-sm leading-relaxed">
            {guestsInvited} guest{guestsInvited === 1 ? '' : 's'} invited — they&apos;ll get the
            join link by email too.
          </p>
        )}
        {guestInviteFailed && (
          <p className="text-warning text-xs leading-relaxed">
            We couldn&apos;t invite everyone — you can re-invite them from the conversation.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button variant="ghost" size="sm" onClick={handleAddToCalendar} className="gap-1.5">
          <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
          Add to calendar
        </Button>
      </div>
      {/* No "View case" — there is no case. This closes the dialog; the client is already on
          the conversation page, so it is just `onDone` (design §Step 3). */}
      <Button onClick={onDone}>Back to conversation</Button>
      {/* `joinPath` IS rendered — as `sr-only` TEXT, never as an anchor (mirrors `StepBooked`).
          Safe by construction: it is the viewer's OWN member route (`/join/m/{meetingId}`),
          never a raw Daily url and never a token, so it discloses nothing the viewer cannot
          already reach. An earlier comment here claimed it was "not rendered", which would have
          misled the next auditor into skipping the line below. */}
      <span className="sr-only">{joinPath}</span>
    </div>
  );
}
