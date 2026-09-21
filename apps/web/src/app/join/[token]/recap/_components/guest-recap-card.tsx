import Link from 'next/link';
import { ArrowLeft, CalendarClock, Timer, Video } from 'lucide-react';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { Reveal } from '@/components/balo/engagement/reveal';
import { guestInvitationPath } from '@/lib/meetings/join-link';
import type { GuestRecapView } from '../_lib/guest-recap-view-types';
import { GuestRecapSummary } from './guest-recap-summary';
import { GuestRecapFiles } from './guest-recap-files';

/** BAL-492 — shown to an engagement-scope guest ON THEIR OWN anchor recap. */
export const GUEST_RECAP_ENVELOPE_NOTE = 'You were invited to a piece of work, not just this call.';

/** BAL-492 — the label on the onward link to the index. */
export const GUEST_RECAP_INDEX_LINK_LABEL = 'Browse the recaps you can open';

export interface GuestRecapCardProps {
  readonly view: GuestRecapView;
  /** The raw guest token. ⚠ Never rendered as text — threaded to the Files card and the back
   *  link, exactly as `JoinControl` already threads it (§16 of the plan). */
  readonly token: string;
  /**
   * BAL-492 — the onward link to the index, or `null`. ⚠ THREADED FROM THE PAGE, exactly like
   * `recapHref` on `JoinControl` — {@link GuestRecapView} stays the four-key structural-
   * concealment shape and is NOT widened to carry it.
   */
  readonly indexHref: string | null;
}

/**
 * BAL-439 §6.3 — the guest recap page's content: header block → onward note (see below) → the
 * summary card → the files card → a back link to the invitation.
 *
 * ⚠ SINGLE COLUMN, NO RAIL. `join/layout.tsx`'s frame is `max-w-[560px]`, so there is no
 * `lg:` two-column split to get wrong — unlike the member recap, which competes for a rail.
 *
 * ⚠⚠ THIS COMPONENT RENDERS NOTHING R6 CLOSES. No money block, no counterparty card, no
 * roster, no action items panel, no transcript section, no resolve prompt, no recording. There
 * is no field on {@link GuestRecapView} to render any of them from — the absence is structural,
 * not a prop convention.
 *
 * ⚠⚠ BAL-492 — THE NOTE PARAGRAPH HAS TWO CONDITIONS, NOT ONE, because the shipped
 * retrospective sentence and the new envelope note can co-occur on a SIBLING recap reached
 * from the index (`!isOwnMeeting` and `indexHref !== null` both hold there):
 *
 *   | isOwnMeeting | indexHref     | paragraph                     | link  |
 *   |--------------|---------------|--------------------------------|-------|
 *   | true         | non-null      | {@link GUEST_RECAP_ENVELOPE_NOTE} | shown |
 *   | true         | null          | (nothing)                      | hidden |
 *   | false        | non-null      | the EXISTING, UNCHANGED sentence | shown |
 *   | false        | null          | the EXISTING, UNCHANGED sentence | hidden |
 *
 * The existing sentence is never edited; the new note renders ONLY on the anchor
 * (`isOwnMeeting: true`), because that is structurally the ONLY place the existing sentence
 * never renders (`resolve-guest-recap-access.ts`'s `isOwnMeeting` is `true` there by
 * definition). The link itself renders whenever `indexHref !== null`, independent of which
 * paragraph (or neither) is showing.
 */
export function GuestRecapCard({
  view,
  token,
  indexHref,
}: Readonly<GuestRecapCardProps>): React.JSX.Element {
  const { header, summary, isOwnMeeting, meetingId } = view;

  let noteText: string | null = null;
  if (isOwnMeeting) {
    if (indexHref !== null) {
      noteText = GUEST_RECAP_ENVELOPE_NOTE;
    }
  } else {
    noteText = 'This call is part of the same piece of work you were invited to.';
  }

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

          {/* ⚠⚠ BAL-492 — see the component docblock's two-condition table. `noteText` is
              `null` only on the anchor of a `meeting`-scope guest, which is the normal case,
              not an empty state (§12 of the original plan). */}
          {noteText !== null && (
            <p className="text-muted-foreground mt-4 text-[12.5px] leading-relaxed">{noteText}</p>
          )}

          {indexHref !== null && (
            <Link
              href={indexHref}
              prefetch={false}
              className="text-primary hover:text-primary/80 focus-visible:ring-ring mt-2 inline-flex min-h-11 items-center gap-1 rounded-md text-[12.5px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              {GUEST_RECAP_INDEX_LINK_LABEL}
            </Link>
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
