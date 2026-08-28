import Link from 'next/link';
import { ArrowLeft, CalendarClock, Timer, Video } from 'lucide-react';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { Reveal } from '@/components/balo/engagement/reveal';
import { guestInvitationPath } from '@/lib/meetings/join-link';
import type { GuestRecapView } from '../_lib/guest-recap-view-types';
import { GuestRecapSummary } from './guest-recap-summary';
import { GuestRecapFiles } from './guest-recap-files';

export interface GuestRecapCardProps {
  readonly view: GuestRecapView;
  /** The raw guest token. ⚠ Never rendered as text — threaded to the Files card and the back
   *  link, exactly as `JoinControl` already threads it (§16 of the plan). */
  readonly token: string;
}

/**
 * BAL-439 §6.3 — the guest recap page's content: header block → retrospective note (only when
 * `!isOwnMeeting`) → the summary card → the files card → a back link to the invitation.
 *
 * ⚠ SINGLE COLUMN, NO RAIL. `join/layout.tsx`'s frame is `max-w-[560px]`, so there is no
 * `lg:` two-column split to get wrong — unlike the member recap, which competes for a rail.
 *
 * ⚠⚠ THIS COMPONENT RENDERS NOTHING R6 CLOSES. No money block, no counterparty card, no
 * roster, no action items panel, no transcript section, no resolve prompt, no recording. There
 * is no field on {@link GuestRecapView} to render any of them from — the absence is structural,
 * not a prop convention.
 */
export function GuestRecapCard({ view, token }: Readonly<GuestRecapCardProps>): React.JSX.Element {
  const { header, summary, isOwnMeeting, meetingId } = view;

  return (
    <div className="space-y-5">
      <Reveal delay={0.1}>
        <header className="border-border bg-card rounded-2xl border p-6 shadow-sm sm:p-8">
          <span className="border-border bg-muted/40 text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium">
            <Video className="h-3 w-3" aria-hidden="true" />
            {header.contextLabel}
          </span>

          <h1 className="text-foreground mt-4 text-xl font-semibold tracking-tight">The recap</h1>

          <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
            <span className="inline-flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
              <LocalDateTime iso={header.occurredAtIso} />
            </span>

            {/* ⚠ `durationMinutes === null` renders NOTHING — never "0 min", never a
                placeholder (`meeting-duration.ts`'s own rule). */}
            {header.durationMinutes !== null && (
              <>
                <span aria-hidden="true" className="text-muted-foreground/50">
                  ·
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Timer className="h-3.5 w-3.5" aria-hidden="true" />
                  {header.durationMinutes} min
                </span>
              </>
            )}
          </div>

          {/* ⚠ NOT rendered when `isOwnMeeting` — its absence is the normal case, not an
              empty state (§12 of the plan). */}
          {!isOwnMeeting && (
            <p className="text-muted-foreground mt-4 text-[12.5px] leading-relaxed">
              This call is part of the same piece of work you were invited to.
            </p>
          )}
        </header>
      </Reveal>

      <Reveal delay={0.15}>
        <GuestRecapSummary summary={summary} />
      </Reveal>

      <Reveal delay={0.2}>
        <GuestRecapFiles meetingId={meetingId} guestToken={token} />
      </Reveal>

      {/* ⚠⚠ `prefetch={false}` IS LOAD-BEARING. The invitation route's GET stamps
          `recordAccess` — a prefetched back link would stamp an access nobody made. */}
      <Link
        href={guestInvitationPath(token)}
        prefetch={false}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md px-1 text-[12.5px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to the invitation
      </Link>
    </div>
  );
}
