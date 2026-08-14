'use client';

import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { GuestRosterRow } from '@/lib/meetings/guest-roster';
import { MeetingAvatar } from './meeting-avatar';

/**
 * BAL-436 — ONE roster row: avatar · name (+ UNVERIFIED badge) · provenance line · action.
 *
 * ── ⚠⚠ THE UNVERIFIED TREATMENT IS A **BADGE**, NEVER A TOOLTIP ─────────────────────────
 *
 * Mobile cannot hover, and this is the one label on the surface a host has to read before
 * they decide whether to let a stranger into a live call. CLAUDE.md forbids a hover tooltip
 * as the sole explanation; here it would be actively dangerous.
 *
 * ⚠ ITS ONLY INPUT IS `row.isUnverified`, which is `inviteChannel === 'link'` and nothing
 * else. It does NOT clear when a host admits the person, it does NOT clear on a re-send, and
 * — ⚠⚠ THE ONE THAT ACTUALLY REGRESSED — **it does NOT clear when they walk into the room.**
 * Admitting somebody is a decision, not an identity check, and arriving is not even a
 * decision. `people-panel.tsx`'s "In the call" section therefore renders THIS component for
 * every live participant it can match to a roster row, rather than a bare
 * {@link PresentParticipantRow}; an earlier version rendered only the latter and the badge
 * vanished at exactly the moment a host looks at the list to see who is in the room.
 *
 * ── ⚠⚠ WHAT THIS ROW MAY NOT RENDER, FOR A `link` GUEST ─────────────────────────────────
 *
 * No email address, no domain, no company name, no logo, no avatar image. The initials come
 * from the SELF-DECLARED name only, or a neutral glyph when there is none.
 *
 * ⚠ THAT IS STRUCTURAL, NOT A DISCIPLINE THIS JSX HAS TO KEEP. `projectGuestForViewer`'s
 * `link` arm omits `email`, `emailDomain` and `accessScope` for EVERY viewer and never falls
 * `displayName` back to the address, so the fields are not even on the payload. This
 * component could not render them if it tried.
 *
 * ── ⚠⚠ AND THE OPPOSITE, FOR AN `email` ROW: IT **DOES** RENDER THE ADDRESS ──────────────
 *
 * Absence is not an indicator. An email-channel invitee distinguished only by the lack of a
 * warning badge asks a host to notice something that is not there. So a row the projector gave
 * an `email` (same party, `email` channel — the only combination that survives) shows it. See
 * `verifiedIdentity` below for why that is safe by construction rather than by a condition.
 */

/** The per-state line under the name. ⚠ PROVENANCE, NEVER IDENTITY. */
const STATE_LINE: Readonly<Record<GuestRosterRow['state'], string>> = {
  in_call: 'In the call',
  invited: "Invite sent — hasn't joined yet",
  not_arrived: "Admitted — hasn't loaded the call yet",
  waiting: 'Asked to join using the meeting link',
};

export interface PeoplePanelRowProps {
  readonly row: GuestRosterRow;
  /**
   * Rendered on the right when supplied — the "Re-send link" affordance on a stranded row.
   * ⚠ ABSENT rather than disabled when there is nothing to offer: the slot rule.
   */
  readonly action?: React.ReactNode;
  /** ⚠ NOT `aria-busy`. A spinner glyph, which announces nothing and suppresses nothing. */
  readonly isPending?: boolean;
}

export function PeoplePanelRow({
  row,
  action,
  isPending = false,
}: Readonly<PeoplePanelRowProps>): React.JSX.Element {
  const { guest, isUnverified } = row;
  /**
   * ⚠⚠ **THE POSITIVE INDICATOR. ABSENCE IS NOT AN INDICATOR.**
   *
   * With only a badge on `link` rows, an `email`-channel invitee was distinguished purely by
   * the ABSENCE of a warning — which asks a host to notice something that is not there, on a
   * live call, under time pressure. The address is the fact that actually earns the trust, so
   * a verified row says what it knows.
   *
   * ⚠ IT IS SAFE **BY CONSTRUCTION**, NOT BY THIS CONDITION. `projectGuestForViewer` omits
   * `email` / `emailDomain` entirely on every `link` row and on every cross-party viewer, so
   * the field is simply not on the payload in either case the concealment rule covers. The
   * `!isUnverified` guard is belt-and-braces on top of that — and the panel's concealment sweep
   * feeds a `link` fixture that DOES carry an address, precisely so this stays true.
   *
   * ⚠ THE DOMAIN IS THE FALLBACK, not the preference: a cross-party arm that grew a domain but
   * no address would still tell a host which organisation the person is from.
   */
  const verifiedIdentity = isUnverified ? undefined : (guest.email ?? guest.emailDomain);

  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-2">
      {/* ⚠ INITIALS FROM THE NAME ONLY. Never a domain-derived logo, never a gravatar. */}
      <MeetingAvatar name={guest.displayName} size={34} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-foreground truncate text-sm font-medium">{guest.displayName}</span>
          {isUnverified ? (
            <Badge
              variant="outline"
              className="border-warning/60 bg-warning/15 text-warning shrink-0 px-1.5 py-0 text-[11px] font-semibold tracking-wide uppercase"
            >
              Unverified
            </Badge>
          ) : null}
        </div>
        {verifiedIdentity === undefined ? null : (
          <p className="text-muted-foreground/90 truncate text-xs">{verifiedIdentity}</p>
        )}
        <p className="text-muted-foreground truncate text-xs">{STATE_LINE[row.state]}</p>
      </div>
      {isPending ? (
        <Loader2
          data-testid="people-row-spinner"
          className="text-muted-foreground h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        action
      )}
    </li>
  );
}

/**
 * A live Daily participant with NO roster row behind them — a Balo member, or a guest the
 * poll has not caught up with.
 *
 * ⚠⚠ IT INVENTS NO ROSTER ENTRY AND OFFERS NO ROW ACTION, DELIBERATELY. `presentGuestIdsFrom`
 * fails closed, so an unrecognised participant is one we cannot attribute — rendering an
 * Admit or a Re-send beside them would be offering an act against a row that may not exist.
 * The name comes from Daily's own `user_name` claim, which the SERVER minted into the token.
 */
export function PresentParticipantRow({
  displayName,
  isSelf = false,
}: Readonly<{ displayName: string; isSelf?: boolean }>): React.JSX.Element {
  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-2">
      <MeetingAvatar name={displayName} size={34} />
      <div className="min-w-0 flex-1">
        <span className={cn('text-foreground truncate text-sm font-medium')}>
          {isSelf ? 'You' : displayName}
        </span>
      </div>
    </li>
  );
}
