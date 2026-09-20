import Link from 'next/link';
import { ArrowLeft, CalendarClock, Timer, Video } from 'lucide-react';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { Reveal } from '@/components/balo/engagement/reveal';
import { guestInvitationPath, guestRecapPath } from '@/lib/meetings/join-link';
import type { GuestRecapIndexRowView } from '../_lib/guest-recap-index-view-types';

/** BAL-492 — the index's heading. Names nothing and nobody. */
export const GUEST_RECAP_INDEX_TITLE = 'Your recaps';

/** BAL-492 — authorised, but the envelope holds no `ended` meeting. NOT a denial. */
export const GUEST_RECAP_INDEX_EMPTY_TITLE = 'No recaps to open';
export const GUEST_RECAP_INDEX_EMPTY_BODY =
  "Recaps appear here once a call has finished. You'll get an email link for any call you're invited to.";

export interface GuestRecapIndexCardProps {
  readonly rows: readonly GuestRecapIndexRowView[];
  /** The raw guest token. ⚠ Never rendered as text — threaded to every row link and the back
   *  link, exactly as `GuestRecapCard` threads it. */
  readonly token: string;
}

/**
 * BAL-492 — the guest recap index's content: a heading, then either the row list or the empty
 * state, then a back link to the invitation.
 *
 * ⚠ SERVER COMPONENT. It imports `guestRecapPath` / `guestInvitationPath` from the
 * `server-only` `join-link.ts`, exactly as `guest-recap-card.tsx` does. No `'use client'`.
 *
 * ⚠⚠ EACH ROW DISCLOSES EXACTLY THREE PRIMITIVES — the context label, the date, and (only when
 * known) the duration. No title, no counterparty, no roster, no artefact-state badge. The
 * `GuestRecapIndexRowView` shape makes this structural, not a rendering choice.
 *
 * ⚠⚠ EVERY LINK CARRIES `prefetch={false}` — both the row links and the back link. A
 * prefetched token URL leaks the token in a `Referer` and into the rrweb META frame, which no
 * scrubbing hook reaches (`join-link-never-writes.test.ts`).
 */
export function GuestRecapIndexCard({
  rows,
  token,
}: Readonly<GuestRecapIndexCardProps>): React.JSX.Element {
  return (
    <div className="space-y-5">
      <Reveal delay={0.1}>
        <header className="border-border bg-card rounded-2xl border p-6 shadow-sm sm:p-8">
          <h1 className="text-foreground text-xl font-semibold tracking-tight">
            {GUEST_RECAP_INDEX_TITLE}
          </h1>

          {rows.length === 0 ? (
            <div className="mt-4">
              <p className="text-foreground text-[14px] font-medium">
                {GUEST_RECAP_INDEX_EMPTY_TITLE}
              </p>
              <p className="text-muted-foreground mt-1.5 text-[12.5px] leading-relaxed">
                {GUEST_RECAP_INDEX_EMPTY_BODY}
              </p>
            </div>
          ) : (
            <ul className="-mx-2 mt-4 space-y-1">
              {rows.map((row) => (
                <li key={row.meetingId}>
                  <Link
                    href={guestRecapPath(token, row.meetingId)}
                    prefetch={false}
                    className="hover:bg-muted/40 focus-visible:ring-ring flex min-h-11 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <span className="border-border bg-muted/40 text-muted-foreground inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium">
                      <Video className="h-3 w-3" aria-hidden="true" />
                      {row.contextLabel}
                    </span>

                    <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                        <LocalDateTime iso={row.occurredAtIso} />
                      </span>

                      {row.durationMinutes !== null && (
                        <>
                          <span aria-hidden="true" className="text-muted-foreground/50">
                            ·
                          </span>
                          <span className="inline-flex items-center gap-1.5">
                            <Timer className="h-3.5 w-3.5" aria-hidden="true" />
                            {row.durationMinutes} min
                          </span>
                        </>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </header>
      </Reveal>

      {/* ⚠⚠ `prefetch={false}` IS LOAD-BEARING — see the module docblock. */}
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
