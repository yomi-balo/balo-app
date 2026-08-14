import type { GuestForViewer } from '@balo/shared/meetings';
import { ADMITTED_NOT_ARRIVED_GRACE_MS } from './guests-poll';

/**
 * BAL-436 — the People panel's VIEW MODEL: the guests GET payload plus the live Daily roster,
 * reduced to four labelled sections.
 *
 * PURE — no I/O, no React, no vendor import — which is what makes every rule below a unit
 * test rather than a component test.
 *
 * ── ⚠⚠ SEATS ARE NOT TILES, AND THIS MODULE DELIBERATELY ANSWERS NEITHER ─────────────────
 *
 * The top-bar chip renders the SERVER's `participantCount` / `participantCap` — the very
 * counter the server refuses invites on. The sections below are derived from the LIVE roster
 * and will routinely differ (an invited guest who has not joined holds a seat but has no
 * tile). The panel labels the two differently and never conflates them; nothing here computes
 * a seat count, precisely so it cannot become a second answer to "how full is this meeting".
 */

/**
 * Where one guest stands right now.
 *
 * ⚠ `in_call` IS **DERIVED FROM DAILY**, not from `admission`. A guest can be `admitted` and
 * still not have loaded the room — that gap is the whole reason `not_arrived` exists.
 */
export type GuestRosterState =
  /** `admitted` or `pre_admitted` AND present in the live Daily roster. */
  | 'in_call'
  /** `pre_admitted`, not present → "Invite sent — hasn't joined yet". */
  | 'invited'
  /** `admitted`, not present → "Admitted — hasn't loaded the call yet". */
  | 'not_arrived'
  /** `pending` → the host's admit/deny queue. */
  | 'waiting';

export interface GuestRosterRow {
  readonly guest: GuestForViewer;
  readonly state: GuestRosterState;
  /**
   * ⚠⚠ TRUE FOR EVERY `link` ROW, INDEPENDENT OF `party` AND OF `admission`. The UNVERIFIED
   * badge's ONLY input.
   *
   * A `link` row's name and email were typed by an anonymous visitor holding a forwarded URL
   * — anyone with the meeting link can knock as anyone. Admitting them is not verifying them,
   * so the flag does NOT clear on admit and does NOT clear on a re-send.
   *
   * ⚠ IT IS NOT DERIVED FROM `admission`. The two happen to be 1:1 today only because exactly
   * two writers exist; BAL-134's trust-by-default work could route an email invitee through
   * the queue, and the derivation would silently invert — the badge would vanish from the rows
   * that need it and appear on rows that do not.
   */
  readonly isUnverified: boolean;
  /**
   * `not_arrived` only: has the grace period elapsed since the host admitted them?
   *
   * ⚠ FALSE WHEN `admissionDecidedAt` IS ABSENT, which should not occur on an `admitted` row
   * but is representable on the wire. Never show an affordance whose grace period cannot be
   * evaluated — an immediately-available "Re-send link" on a row somebody admitted one second
   * ago rotates a credential that was working fine.
   */
  readonly canResendLink: boolean;
}

export interface GuestRoster {
  readonly inCall: readonly GuestRosterRow[];
  readonly invited: readonly GuestRosterRow[];
  readonly notArrived: readonly GuestRosterRow[];
  /**
   * ⚠⚠ **EMPTY UNLESS `canHost`.** Gated on the SERVER's per-actor
   * `hasEngagementCapability(HOST_MEETINGS)` verdict, which arrives on the guests GET payload
   * — never on a view, a role string or an active mode. A non-host sees no queue at all
   * rather than a queue with disabled buttons.
   */
  readonly waiting: readonly GuestRosterRow[];
}

export interface BuildGuestRosterInput {
  readonly guests: readonly GuestForViewer[];
  /** From `presentGuestIdsFrom` — the LIVE Daily roster, decoded. */
  readonly presentGuestIds: ReadonlySet<string>;
  /** ⚠ THE SERVER'S VERDICT, off the GET response. Never re-derived in the browser. */
  readonly canHost: boolean;
  /** `Date.now()` at render, passed in so this stays pure and testable. */
  readonly nowMs: number;
}

function canResend(guest: GuestForViewer, nowMs: number): boolean {
  const decidedAt = guest.admissionDecidedAt;
  if (decidedAt === undefined) return false;
  const decidedMs = Date.parse(decidedAt);
  // A malformed instant is not a grace period that has elapsed — it is one that cannot be
  // evaluated, which resolves to "no affordance".
  if (Number.isNaN(decidedMs)) return false;
  return nowMs - decidedMs >= ADMITTED_NOT_ARRIVED_GRACE_MS;
}

/**
 * Reduce the payload to the four sections.
 *
 * ── ⚠⚠ `denied` ROWS ARE DROPPED HERE, AND THAT IS NOT A FILTER OF CONVENIENCE ───────────
 *
 * `meetingGuestsRepository.listLiveByMeeting` filters `deleted_at` / `revoked_at` only, so a
 * denied row can still be on the payload. Rendering it would show a host somebody they
 * already turned away, in a section that implies they are still expected. (In practice
 * BAL-132's `decideAdmission` also stamps `revoked_at` on a denial, so most denied rows
 * never reach here at all — but "most" is not a rule, and the panel must not depend on a
 * write-side detail of another ticket to avoid showing a refused stranger.)
 */
export function buildGuestRoster(input: BuildGuestRosterInput): GuestRoster {
  const inCall: GuestRosterRow[] = [];
  const invited: GuestRosterRow[] = [];
  const notArrived: GuestRosterRow[] = [];
  const waiting: GuestRosterRow[] = [];

  for (const guest of input.guests) {
    if (guest.admission === 'denied') continue;

    const isUnverified = guest.inviteChannel === 'link';

    if (guest.admission === 'pending') {
      // ⚠ THE SERVER'S VERDICT GATES THE WHOLE SECTION. A non-host is not shown the queue.
      if (input.canHost) {
        waiting.push({ guest, state: 'waiting', isUnverified, canResendLink: false });
      }
      continue;
    }

    if (input.presentGuestIds.has(guest.id)) {
      inCall.push({ guest, state: 'in_call', isUnverified, canResendLink: false });
      continue;
    }

    if (guest.admission === 'admitted') {
      notArrived.push({
        guest,
        state: 'not_arrived',
        isUnverified,
        canResendLink: canResend(guest, input.nowMs),
      });
      continue;
    }

    invited.push({ guest, state: 'invited', isUnverified, canResendLink: false });
  }

  return { inCall, invited, notArrived, waiting };
}
