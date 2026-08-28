import 'server-only';

import { meetingGuestsRepository, type Meeting, type MeetingGuest } from '@balo/db';
import type { MeetingGuestAdmissionLabel, MeetingGuestSide } from '@balo/shared/meetings';
import { hashesMatch, sha256Hex } from '@/lib/magic-link';
import { log } from '@/lib/logging';

/**
 * resolve-meeting-guest — BAL-445's ONE per-request GUEST SUBJECT resolver.
 *
 * ⚠ NOT A SESSION, AND THE NAME SAYS SO ON PURPOSE. The ticket title says "read session";
 * there is none and there must not be one. `/join/[token]/page.tsx`'s shipped ruling rules
 * it out: the token IS the credential, it is re-presented on every visit, and a cookie
 * would survive revocation until it expired. `findLiveByTokenHash` re-checks `deleted_at IS
 * NULL AND revoked_at IS NULL AND expires_at > now() AND admission <> 'denied'` plus meeting
 * liveness on EVERY call, and that re-read IS "removing a guest is immediate and total".
 * Anything cached — a cookie, an iron-session variant, a JWT, a server-side record,
 * `localStorage` — breaks it. Do not add one.
 *
 * ⚠ IT IS AN AUTH HELPER, NOT A PUBLIC ACTION (R3). It resolves a presented credential to a
 * **persisted, revocable subject** and fails closed. It is not "no authorization" — it is
 * the same shape as `getSession()`/`getCurrentUser()` (both already on `AUTH_HELPERS`): a
 * primitive through which an action learns *who is calling*. The subject is a
 * `meeting_guests` row that a host can revoke, that expires, and that the database
 * re-validates on every single request. `PUBLIC_ACTION_ALLOWLIST` is for actions that
 * authenticate with **nothing at all** and forward the real gate elsewhere; a guest read
 * action authenticates HERE, so putting it there would silently reclassify an authorized
 * read as public — precisely the failure mode `_read-only-actions.ts` warns about.
 *
 * This module lives in `apps/web` ONLY (R6). `apps/api` deliberately duplicates its own
 * hasher (`apps/api/src/lib/guest-token.ts`) rather than sharing this one: `apps/api`'s
 * tsup bundles at `platform=node` without the `react-server` condition, so a shared module
 * importing `server-only` would resolve to the throwing entry there — typechecks clean,
 * builds green, crash-loops Railway in production (PR #191). Do not merge them.
 */
export interface MeetingGuestSubject {
  /**
   * The live guest row, MINUS `tokenHash`. ⚠ THE CREDENTIAL NEVER TRAVELS PAST THE COMPARE:
   * stripping it here means no caller can log it, thread it or accidentally serialise it.
   */
  readonly guest: Omit<MeetingGuest, 'tokenHash'>;
  /** The guest's OWN meeting, threaded so no caller re-reads it (nor can disagree). */
  readonly meeting: Meeting;
  /**
   * `meeting_guests.party` narrowed to the two-sided CHECK.
   *
   * ⚠ IT IS NOT AN AUTHORIZATION INPUT AND IT IS NOT A RESOLVED SIDE ON A `link` ROW —
   * `claimLobbyPlace` writes `client` because the column is NOT NULL, not because anybody
   * resolved a side. `presencePartyForGuest` refuses to derive MONEY from it and
   * `projectGuestForViewer` refuses to derive SAME-PARTY ENTITLEMENT from it. Nothing in
   * this PR derives READ ENTITLEMENT from it either.
   */
  readonly side: MeetingGuestSide;
  /**
   * ⚠ BAL-445 fix-round-1 (F1) — `meeting_guests.admission`, restated here so a READ gate can
   * enforce `guestIsAdmittedForRead` WITHOUT reaching back into `guest` for it. This resolver
   * DELIBERATELY STILL RESOLVES a `pending` row (see this function's docblock) — `/join/[token]`
   * legitimately renders the waiting card for a not-yet-admitted guest, and
   * `pollGuestAdmissionAction` depends on that. The admission check belongs at the READ gate
   * (`authorizeMeetingFileAccess`'s guest arm), never pushed down into this resolver.
   */
  readonly admission: MeetingGuestAdmissionLabel;
}

/**
 * Narrow the three-label `meeting_participant_party` enum to the TWO a guest may sit on.
 * Moved here verbatim from `[token]/page.tsx` — the single expression of the rule.
 *
 * `meeting_guest_party_two_sided` makes `observer` unrepresentable in this table, so `null`
 * here means a CORRUPT ROW, never a legitimate third case. The caller fails CLOSED on it.
 */
function guestSide(party: string): MeetingGuestSide | null {
  if (party === 'client' || party === 'expert') {
    return party;
  }
  return null;
}

function withoutTokenHash(guest: MeetingGuest): Omit<MeetingGuest, 'tokenHash'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately dropping the credential
  const { tokenHash: _tokenHash, ...rest } = guest;
  return rest;
}

/**
 * Resolve a presented guest token to a live subject.
 *
 * Lifted from `page.tsx`'s inlined extraction, unchanged in order and outcome:
 * hash → look up LIVE-only → constant-time re-compare → narrow `party` to a side.
 *
 * ⚠ FAILURE MODE — ONE `null`, INDISTINGUISHABLE FROM A STRANGER. Returned identically for:
 * wrong token, expired, revoked, soft-deleted, `denied` admission, meeting cancelled,
 * meeting soft-deleted, and a corrupt `party`. No discriminant, no thrown error — this is
 * what preserves `page.tsx`'s "ONE IDENTICAL CARD FOR EVERY WAY THIS CAN FAIL" property. A
 * thrown error, or a discriminated failure union, would put an oracle one `catch` away in
 * every consumer. It is deliberately not `requireX`-shaped: `requireUser()` throws, and a
 * throw here would have to be caught and collapsed in every caller.
 *
 * ⚠ AN `ended` MEETING STILL RESOLVES, deliberately — the repository's shipped asymmetry
 * with the mutation gate. A guest whose call has ended can still read its files and
 * transcript, which is the whole point of `access_scope` outliving the call.
 *
 * ⚠ RATE LIMITING IS THE CALLER'S, AND IT IS NOT OPTIONAL. This resolver deliberately does
 * NOT limit: a shared limiter would key on the wrong thing and hide the ordering (rate
 * limit BEFORE hashing — that is what makes step 4 affordable under a scanner storm). Every
 * consumer must call `checkMemoryLimit` with its own surface-prefixed key BEFORE calling
 * this function. Omitting it turns the caller into an unbounded, unauthenticated DB-read
 * amplifier.
 */
export async function resolveMeetingGuestSubject(
  rawToken: string
): Promise<MeetingGuestSubject | null> {
  const tokenHash = sha256Hex(rawToken);
  const row = await meetingGuestsRepository.findLiveByTokenHash(tokenHash);
  if (row === undefined || !hashesMatch(tokenHash, row.guest.tokenHash)) {
    // A hash PREFIX only — enough to correlate an incident, never enough to replay.
    log.info('Guest join link not active', { tokenHashPrefix: tokenHash.slice(0, 8) });
    return null;
  }

  const side = guestSide(row.guest.party);
  if (side === null) {
    log.warn('Guest row carries an unplaceable party', { guestId: row.guest.id });
    return null;
  }

  return {
    guest: withoutTokenHash(row.guest),
    meeting: row.meeting,
    side,
    admission: row.guest.admission,
  };
}
