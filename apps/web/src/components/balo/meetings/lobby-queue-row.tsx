'use client';

import { useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { GuestRosterRow } from '@/lib/meetings/guest-roster';
import { MeetingAvatar } from './meeting-avatar';

/**
 * BAL-436 — ONE waiting-to-join row, with the host's Admit / Deny pair.
 *
 * ── ⚠⚠ THIS ROW EXISTS ONLY WHEN THE SERVER SAID `canHost` ──────────────────────────────
 *
 * The whole section is gated on `canHost` from the guests GET payload — the server's
 * per-actor `hasEngagementCapability(HOST_MEETINGS)` verdict, computed behind the tenancy
 * gate. The design prototype gates its queue on a VIEW instead (`balo-in-meeting-ui.jsx:618`);
 * that is the comparison ADR-1029 forbids, and `meeting-call-no-lens-gate.test.ts` fails the
 * build of anyone who copies it. **Take the layout; do not take its gate.**
 *
 * ── ⚠⚠ EVERYTHING ON THIS ROW IS SELF-DECLARED ──────────────────────────────────────────
 *
 * A `link`-channel knock's name was typed by an anonymous visitor holding a forwarded URL:
 * anyone with the meeting link can knock as anyone. The badge says so plainly, the state line
 * describes PROVENANCE rather than identity, and the address is not on the payload at all
 * (`projectGuestForViewer`'s `link` arm removes it before it can reach a browser).
 *
 * ⚠ NO `aria-busy` — it suppresses the live-region announcements this surface depends on.
 * The pending state swaps the two buttons for a spinner glyph, which announces nothing and
 * suppresses nothing.
 */

export interface LobbyQueueRowProps {
  readonly row: GuestRosterRow;
  /**
   * ⚠ THE DISPLAY NAME TRAVELS WITH THE DECISION so the panel's toast and its live-region
   * announcement can both name the person ("Taylor Wu is in.", not "They're in."). The row
   * already holds it; making the panel look it up again would be a second read of the same
   * fact, racing the poll that may already have removed the row.
   */
  readonly onDecide: (guestId: string, decision: 'admit' | 'deny', displayName: string) => void;
  /** ⚠ PER-ROW, never panel-wide: one slow decision must not freeze the whole queue. */
  readonly isPending: boolean;
}

export function LobbyQueueRow({
  row,
  onDecide,
  isPending,
}: Readonly<LobbyQueueRowProps>): React.JSX.Element {
  const { guest, isUnverified } = row;

  const admit = useCallback(
    () => onDecide(guest.id, 'admit', guest.displayName),
    [guest.id, guest.displayName, onDecide]
  );
  const deny = useCallback(
    () => onDecide(guest.id, 'deny', guest.displayName),
    [guest.id, guest.displayName, onDecide]
  );

  return (
    // ⚠⚠ A NEUTRAL ROW, NOT `bg-primary/10`. The primary tint is this design system's
    // POSITIVE / SELECTED tone, and painting it under a row whose whole message is "we have
    // not checked who this is" made the visual hierarchy contradict the copy. The row is
    // separated by an edge and a hairline instead, which reads as "needs a decision" without
    // reading as "approved".
    <li className="border-warning/40 bg-muted/30 flex items-center gap-3 rounded-lg border-l-2 px-2 py-2">
      <MeetingAvatar name={guest.displayName} size={34} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-foreground truncate text-sm font-medium">{guest.displayName}</span>
          {/*
            ⚠ A BADGE, NOT A TOOLTIP — mobile cannot hover, and this is the label the host has
            to read before deciding.

            ⚠⚠ IT READS `row.isUnverified`, IT IS NOT HARDCODED. Every row that reaches this
            component is `link`-channel TODAY, so the two are indistinguishable right now — but
            the badge is a claim about `inviteChannel`, and the moment BAL-134's
            trust-by-default work routes an EMAIL invitee through the queue, a hardcoded badge
            would be asserting "Balo hasn't checked who this is" about somebody a host invited
            by name. A security label must state what it means.

            ⚠⚠ IT OUTRANKS THE BUTTONS, DELIBERATELY. At `text-[10px]` it was the quietest
            element in the row it governs, sitting beside a filled primary Admit — the reader's
            eye reached the action before the warning. `text-[11px]` plus a filled warning tone
            puts the disclosure above the controls in the visual order, which is the order it
            has to be read in.
          */}
          {isUnverified ? (
            <Badge
              variant="outline"
              className="border-warning/60 bg-warning/15 text-warning shrink-0 px-1.5 py-0 text-[11px] font-semibold tracking-wide uppercase"
            >
              Unverified
            </Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground truncate text-xs">
          Asked to join using the meeting link
        </p>
      </div>

      {isPending ? (
        <Loader2
          data-testid="queue-row-spinner"
          className="text-muted-foreground h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <div className="flex shrink-0 items-center gap-1.5">
          {/*
            ⚠ THE ACCESSIBLE NAMES CARRY THE PERSON, THE VISIBLE LABELS STAY SHORT. A screen
            reader hearing "Deny, button" eight times down a queue has no idea which row it is
            on; a sighted host reading "Deny Taylor Wu" on a 360px panel loses the row to
            wrapping. Both audiences get what they need from one control.
          */}
          <button
            type="button"
            onClick={deny}
            aria-label={`Deny ${guest.displayName}`}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 items-center rounded-lg border px-2.5 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            Deny
          </button>
          {/*
            ⚠⚠ ADMIT AND DENY CARRY **EQUAL** WEIGHT — both outlined, neither filled. A filled
            primary Admit is a recommendation, and this surface must not recommend letting an
            unverified stranger into a live call. The panel's own disclosure says "admit them
            only if you're expecting them"; a default-styled button beside it said the
            opposite, louder. Admit keeps the primary TEXT colour so the two are still
            instantly distinguishable at a glance.
          */}
          <button
            type="button"
            onClick={admit}
            aria-label={`Admit ${guest.displayName}`}
            className="border-primary/60 text-primary hover:bg-primary/10 focus-visible:ring-ring inline-flex min-h-11 items-center rounded-lg border px-2.5 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            Admit
          </button>
        </div>
      )}
    </li>
  );
}
