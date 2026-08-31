'use client';

import Link from 'next/link';
import { CalendarDays, CalendarCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconBadge } from '@/components/balo/icon-badge';
import { track, CALENDAR_EVENTS } from '@/lib/analytics';

interface NoCalendarConnectedEmptyStateProps {
  readonly href: string;
}

/**
 * Empty state (a) — no calendar connected. Invitation-framed (balo-ui-skill: keep-with-
 * invitation), takes priority over (b), keyed on `checklist.items.calendar` (never meeting
 * count). CTA fires `calendar_connect_cta_clicked` with `source: 'empty_state'`.
 *
 * ⚠ BAL-512 MOVED THIS EVENT. It used to fire
 * `calendar_edit_availability_clicked { source: 'empty_state_no_calendar' }`, which put a
 * CONNECTION intent into the availability-UPKEEP funnel — the two things BAL-498's business
 * questions ask about separately. The destinations were never the same either: this CTA goes to
 * `?tab=schedule&setup=calendar`, the header action to `?tab=schedule`. Do not move it back.
 */
export function NoCalendarConnectedEmptyState({
  href,
}: Readonly<NoCalendarConnectedEmptyStateProps>): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-xl border p-8 text-center sm:p-10">
      <div className="mb-4 flex justify-center">
        <IconBadge icon={CalendarDays} color="#2563EB" size={56} iconSize={26} />
      </div>
      <h2 className="text-foreground text-lg font-semibold">Connect a calendar to see your week</h2>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm leading-relaxed">
        Once you connect Google or Microsoft, Balo can shade your available hours here and keep your
        bookings in sync automatically.
      </p>
      <div className="mt-6 flex justify-center">
        <Button
          asChild
          onClick={() => track(CALENDAR_EVENTS.CONNECT_CTA_CLICKED, { source: 'empty_state' })}
        >
          {/* R5 — an ordinary in-app settings route: `next/link`, not a full document reload. */}
          <Link href={href}>Connect your calendar</Link>
        </Button>
      </div>
    </div>
  );
}

interface NothingScheduledEmptyStateProps {
  readonly view: 'week' | 'agenda';
  /**
   * ⚠ THE CLAIM "your availability is still visible to clients" IS ONLY MADE WHEN IT IS KNOWN
   * TRUE (BAL-498 fix round 5, F5). Both copies used to assert it unconditionally, which is
   * FALSE for exactly the states the shading surface already models — an unpublished profile
   * (`not_published`) or unconfigured availability (`not_configured`) means clients see nothing
   * to book, and the page would have been reassuring an expert about a thing that is not
   * happening.
   *
   * The one signal that positively establishes it is `availabilityView.kind === 'ready'`: the
   * public `GET /experts/:id/availability` returned 200 with at least one bookable slot, which
   * requires the profile to be live AND availability configured AND time actually free. Every
   * other kind — and Agenda, where no shading query runs at all — is `false`, and the copy
   * drops to the forward-looking half, which is true in all cases. Defaults to `false` so a new
   * call site cannot assert it by omission; threaded from a signal `CalendarShell` already
   * holds, never a new fetch.
   */
  readonly availabilityVisibleToClients?: boolean;
}

/**
 * The forward-looking sentence, true in every state — no claim about what clients can currently
 * see. Invitation-framed rather than absence-framed (CLAUDE.md's empty-state rule) and
 * gender-neutral.
 */
const BOOKINGS_ONLY = 'Bookings will show up here as soon as someone schedules time with you.';

/** The same sentence, prefixed with the reassurance — used ONLY when it is known true. */
const AVAILABILITY_VISIBLE_AND_BOOKINGS =
  'Your availability is still visible to clients — bookings will show up here as soon as someone schedules time with you.';

/** Empty state (b) — connected, nothing scheduled. No CTA — both possible actions (booking,
 *  availability editing) are explicit ticket non-goals. */
export function NothingScheduledEmptyState({
  view,
  availabilityVisibleToClients = false,
}: Readonly<NothingScheduledEmptyStateProps>): React.JSX.Element {
  const reassurance = availabilityVisibleToClients
    ? AVAILABILITY_VISIBLE_AND_BOOKINGS
    : BOOKINGS_ONLY;

  if (view === 'week') {
    return (
      <p className="text-muted-foreground py-3 text-center text-sm">
        Nothing on the calendar this week. {reassurance}
      </p>
    );
  }
  return (
    <div className="border-border bg-card rounded-xl border p-8 text-center sm:p-10">
      <div className="mb-4 flex justify-center">
        <IconBadge icon={CalendarCheck} color="#16a34a" size={56} iconSize={26} />
      </div>
      <h2 className="text-foreground text-lg font-semibold">You&apos;re all clear</h2>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm leading-relaxed">
        {reassurance}
      </p>
    </div>
  );
}
