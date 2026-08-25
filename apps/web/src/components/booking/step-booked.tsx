'use client';

import { useRouter } from 'next/navigation';
import { CalendarPlus, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatSlotDateTime } from './format';
import { downloadIcsEvent } from './ics';

export interface StepBookedProps {
  engagementId: string;
  caseTitle: string;
  isNewCase: boolean;
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
 * BAL-400 Step 3 — booked state, both copy variants (new / attach). ⚠⚠ D2a: the copy NEVER
 * claims the client's calendar was updated — only the expert's is (server-side, out of view
 * here). "The join link is on its way to your email."
 */
export function StepBooked({
  engagementId,
  caseTitle,
  isNewCase,
  expertFirstName,
  startIso,
  viewerTimezone,
  durationMinutes,
  provisioned,
  joinPath,
  guestsInvited,
  guestInviteFailed,
  onDone,
}: Readonly<StepBookedProps>): React.JSX.Element {
  const router = useRouter();
  const name = expertFirstName ?? 'them';
  const when = formatSlotDateTime(startIso, viewerTimezone);
  const caseVerb = isNewCase ? 'This started a new case' : 'Added to your case';

  function handleAddToCalendar(): void {
    downloadIcsEvent({
      summary: `Consultation with ${name}`,
      startIso,
      durationMinutes,
      filename: 'consultation.ics',
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
          {when} · {durationMinutes}-minute consultation with {name}. {caseVerb} — &ldquo;
          {caseTitle}&rdquo;.
        </p>
        {/* ⚠ M6 — THE UNPROVISIONED BRANCH PROMISES NOTHING. No repair sweep, no retry job and
            no provision-on-join exists (`join-meeting.ts` refuses an unprovisioned meeting), so
            "the join link is on its way to your email" was an undertaking the platform cannot
            keep. What IS true is that the booking committed and the failure was logged and
            tracked. The follow-up ticket that adds the repair path re-earns the promise. */}
        <p className="text-muted-foreground text-sm leading-relaxed">
          {provisioned
            ? 'The join link is on its way to your email.'
            : "Your time is held, but your call room isn't ready yet — our team has been alerted. Check the case for the latest."}
        </p>
        {guestsInvited > 0 && (
          <p className="text-muted-foreground text-sm leading-relaxed">
            {guestsInvited} guest{guestsInvited === 1 ? '' : 's'} invited — they&apos;ll get the
            join link by email too.
          </p>
        )}
        {guestInviteFailed && (
          <p className="text-warning text-xs leading-relaxed">
            We couldn&apos;t invite everyone — you can re-invite them from the case.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onDone();
            router.push(`/cases/${engagementId}`);
          }}
        >
          View case
        </Button>
        <Button variant="ghost" size="sm" onClick={handleAddToCalendar} className="gap-1.5">
          <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
          Add to calendar
        </Button>
      </div>
      <Button onClick={onDone}>Done</Button>
      {/* `joinPath` is not rendered as a raw link here — the case surface is the durable place
          a member joins from; keeping it out of Step 3 avoids a second, easy-to-lose copy of it. */}
      <span className="sr-only">{joinPath}</span>
    </div>
  );
}
