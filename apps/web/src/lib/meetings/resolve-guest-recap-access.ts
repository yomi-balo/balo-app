import 'server-only';

import type { Meeting } from '@balo/db';
import type { GuestAccessScopeLabel, PrimaryMeetingContext } from '@balo/shared/meetings';
import { authorizeMeetingFileAccess } from './authorize-meeting-file-access';
import { resolveMeetingGuestSubject } from './resolve-meeting-guest';

/**
 * BAL-439 — the GUEST RECAP READ GATE. A sibling to `resolveRecapAccess` (R5), not a widening
 * of it: `RecapLens` stays `'client' | 'expert'` and `resolveRecapAccess` keeps its member-only
 * `(meetingId, userId)` signature and its explicit refusal of a guest verdict — see that
 * module's own docblock and `resolve-recap-access.test.ts:109-125`, which stays true unchanged.
 *
 * ⚠⚠ THE CHAIN IS NOT FORKED. "Who may read this meeting" is defined ONCE, in
 * `authorize-meeting-file-access.ts` — UNTOUCHED by this ticket (AC 5 / R4), not even a
 * docblock. This module composes exactly two shipped primitives and adds no rule of its own:
 *
 *   1. `resolveMeetingGuestSubject` (BAL-445) — the per-request credential. Its re-read on
 *      every call IS the revocation guarantee (R1); nothing here caches it.
 *   2. `authorizeMeetingFileAccess` — the shipped gate, dispatched to its GUEST arm
 *      (`authorizeGuestFileAccess`), which itself calls `guestMayReadMeeting` (R3: reached
 *      THROUGH the file gate, never imported or called directly by this module or by anything
 *      downstream of it).
 *
 * ⚠⚠ NO `companyId`, NO `expertProfileId`, NO `side` — the guest `ok:true` arm returns none of
 * them, deliberately (R4). This gate does not widen that arm to carry one: the guest recap
 * renders NO counterparty card and NO roster at all, so there is nothing to hydrate one for.
 *
 * ⚠ NO LOGGING IN THIS MODULE, deliberately. Every denial is already logged one level down —
 * `resolveMeetingGuestSubject` logs its own `null`, and `authorizeMeetingFileAccess`'s `deny()`
 * logs a distinct `reason` per shape. A third log line here would be duplicate noise, and
 * keeping `@/lib/logging` out of this file is what lets it take the SCANNED path (rather than
 * the `server-only`-plus-`@balo/db` carve-out) on `meeting-call-no-lens-gate.test.ts` — being
 * scanned is itself the structural proof that this gate can never acquire a lens.
 *
 * ⚠ NO LIFECYCLE CHECK IN THIS MODULE, deliberately — exact symmetry with the member pair:
 * `resolveRecapAccess` does not discharge lifecycle either; the ROUTE'S LOADER does
 * (`load-guest-recap.ts`'s `meeting.status !== 'ended'` guard). Ours matches.
 */

export interface GuestRecapAccess {
  /** `meeting_guests.id` — a LOG handle. NEVER a `users.id` and never rendered. */
  readonly guestId: string;
  /** The grant AS RECORDED. Threaded for logging; not rendered. */
  readonly accessScope: GuestAccessScopeLabel;
  /** The TARGET meeting row. Threaded so the loader never re-reads it. */
  readonly meeting: Meeting;
  /** The PRIMARY context that governs the target meeting. Never `admin`. */
  readonly subject: PrimaryMeetingContext;
  /** TRUE when the target IS the meeting the guest was invited to. */
  readonly isOwnMeeting: boolean;
}

/**
 * Resolve a guest's token to a verdict on ONE target meeting, or `null`.
 *
 * ⚠ ONE `null` FOR EVERY DENIAL — an unresolvable token, a gate refusal (out-of-scope meeting,
 * pending admission, a declined request-grain relationship, an ambiguous/admin-only context)
 * and a MEMBER payload (unreachable in practice given the actor passed below, but still part of
 * the gate's static return type — see the branch below) all collapse into it. The caller answers
 * one `LinkNotActive` card with one shape, so this surface is never an existence oracle.
 */
export async function resolveGuestRecapAccess(
  rawToken: string,
  meetingId: string
): Promise<GuestRecapAccess | null> {
  const subject = await resolveMeetingGuestSubject(rawToken);
  if (subject === null) {
    return null;
  }

  const access = await authorizeMeetingFileAccess({
    meetingId,
    actor: { kind: 'guest', guest: subject },
  });
  if (!access.ok) {
    return null;
  }

  /**
   * ⚠⚠ THE MIRROR IMAGE OF `resolve-recap-access.ts`'s member refusal. Unreachable in practice
   * given the `actor: { kind: 'guest' }` passed above — but `AuthorizeMeetingFileAccessResult`'s
   * MEMBER `ok:true` arm (with its `side` / `companyId` / `expertProfileId`) is still part of
   * the gate's STATIC return type, so this branch is what stops a member payload ever being
   * renamed into a guest view. Written as an explicit refusal, not a cast — the same reasoning
   * the member gate records for its own mirror-image branch.
   */
  if (access.viewer !== 'guest') {
    return null;
  }

  return {
    guestId: access.guestId,
    accessScope: access.accessScope,
    meeting: access.meeting,
    subject: access.subject,
    isOwnMeeting: access.guestMeeting.id === access.meeting.id,
  };
}
