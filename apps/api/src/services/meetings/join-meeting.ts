/**
 * BAL-132 — THE JOIN SERVICE. Three operations, one shared credential shape:
 *
 *   · `joinMeetingAsMember` — an authenticated Balo user joins a meeting they belong to.
 *   · `joinMeetingAsGuest`  — a token-bearing guest mints, OR is told to keep waiting.
 *   · `claimLobbyPlace`     — an ANONYMOUS visitor knocks and joins the admission queue.
 *
 * ⚠⚠ THIS FILE IS THE ENTIRE AUTHORIZATION SURFACE OF THE FEATURE. Daily enforces nothing:
 * every room is `privacy: 'private'`, so a minted token IS entry and no token IS refusal.
 * Whatever this module decides is what the product does.
 *
 * ── ⚠⚠ DECISION 2: ADMIT DOES NOT MINT; THE GUEST'S NEXT POLL MINTS ─────────────────────
 *
 * The ticket says "the Admit action MINTS a short-lived guest token at admit time". Taken
 * literally that would put the mint in `decideGuestAdmission` — which is called by the HOST,
 * who has nowhere to put a credential belonging to somebody else. Handing the guest's token
 * to the host's browser, or persisting it so the guest can fetch it later, both make things
 * strictly worse than the alternative.
 *
 * SO THE PROPERTY IS PRESERVED EXACTLY, BY A DIFFERENT MECHANISM. **A `pending` guest has NO
 * DAILY TOKEN IN EXISTENCE ANYWHERE.** Their client polls `joinMeetingAsGuest`; while
 * `pending` it returns `waiting` and mints nothing, emits nothing, and writes nothing. The
 * moment a host flips `admission` to `admitted`, the SAME call mints. A DENIED row is
 * filtered out of `findLiveByTokenHash` entirely, so denial can never produce a mint on any
 * path, ever.
 *
 * The requirement — "the queue enforces via token issuance, not UI" — holds verbatim: entry
 * is impossible without a mint, and a mint is impossible without an admit. `decideAdmission`
 * stays a pure state transition, and no credential ever travels to the wrong party. The
 * ABSENCE is asserted by tests, because the absence is the whole property.
 *
 * ── ⚠ THE ERROR LITERALS, AND WHY ONE OF THEM IS WIDER THAN THE OTHERS ──────────────────
 *
 * `meeting_not_found` is the COLLAPSE: no such meeting, soft-deleted, unresolvable or
 * ambiguous context, admin-only context, not your party, no capability, and an unknown /
 * expired / revoked / DENIED guest token, and a guest token whose meeting disagrees with the
 * URL. There is NO 403 on this surface and no code distinguishes any of those — the SHAPE
 * goes to `log.warn` as a distinct field, never to the wire.
 *
 * The other three literals are safe as distinct codes ONLY because each is reachable strictly
 * AFTER authorization has succeeded (member arm) or a valid 256-bit token has resolved (guest
 * arm). They confirm nothing to an unauthorized caller.
 *
 * ⚠⚠ AND `claimLobbyPlace` IS THE EXCEPTION THAT MAKES THAT RULE READABLE: it has NO
 * authorization at all, so EVERY failure — cancelled meeting, ended meeting, participant cap,
 * no such meeting — collapses into `meeting_not_found`. Distinguishing "cancelled" from "no
 * such meeting" for an anonymous holder of a GUESSED uuid is an existence oracle over every
 * meeting on the platform. Do not "improve" the lobby's error reporting.
 */
import {
  meetingContextsRepository,
  meetingGuestsRepository,
  meetingsRepository,
  usersRepository,
  type MeetingGuest,
  type MeetingGuestAdmission,
} from '@balo/db';
import {
  GUEST_SERVER_EVENTS,
  MEETING_SERVER_EVENTS,
  trackServer,
  type GuestJoinMethod,
} from '@balo/analytics/server';
import { extractEmailDomain } from '@balo/shared/domains';
import { createLogger } from '@balo/shared/logging';

import {
  GUEST_TOKEN_TTL_AFTER_END_MS,
  MAX_LOBBY_QUEUE,
  MAX_MEETING_PARTICIPANTS,
  RESERVED_BASE_PARTICIPANTS,
  dailyParticipantIdFor,
  dailyRoomNameForMeeting,
  selectPrimaryMeetingContext,
  type JoinGrant,
  type MemberJoinContext,
  type MeetingGuestSide,
  type MeetingViewerRole,
} from '@balo/shared/meetings';
import { personDisplayName } from '@balo/shared/parties';
import { dailyMeetingTokenMinter, type MeetingTokenMinter } from '../daily/meeting-tokens.js';
import { DailyApiError, DailyConfigError } from '../daily/errors.js';
import {
  guestTokenHashesMatch,
  hashGuestToken,
  mintGuestInviteToken,
} from '../../lib/guest-token.js';
import { authorizeMeetingParticipation } from './authorize-meeting-participation.js';
import { resolveEndAuthority } from './authorize-end-meeting.js';
import { assertMeetingJoinable } from './meeting-liveness.js';
import { canonicalEmail } from './guest-participation.js';
import { resolveMeetingContextLabel } from './resolve-meeting-context-label.js';
import { resolveWaitingCounterparty } from './resolve-waiting-counterparty.js';

const log = createLogger('join-meeting');

/** Every wire literal this service can produce. All fixed; none derived from an error. */
export type JoinErrorCode =
  | 'meeting_not_found'
  | 'meeting_not_open_for_join'
  | 'meeting_not_provisioned'
  | 'meeting_token_unavailable';

/**
 * ⚠⚠ `JoinGrant` — WHAT A CALLER RECEIVES ON SUCCESS — IS DEFINED IN `@balo/shared/meetings`,
 * AND IS **NOT RE-EXPORTED FROM HERE**. `apps/web`'s join client used to declare its own copy
 * linked to this one BY A COMMENT, so renaming a field on either side left both green and the
 * failure surfaced as a browser holding a credential it could not use. The fix was ONE
 * definition in the shared package — and a re-export here would immediately give it two import
 * paths again, which is the same ambiguity in a smaller form. (The re-export that shipped had
 * no importer: this module's only caller, `routes/meetings/join.ts`, takes `JoinErrorCode` and
 * nothing else.) **BAL-435 imports it from `@balo/shared/meetings`.**
 */
export type JoinMeetingResult =
  | {
      readonly ok: true;
      readonly grant: JoinGrant;
      /**
       * BAL-435 (R6) — the meeting's context, for the in-call chrome's heading and its
       * "Back to {context}" link.
       *
       * ⚠⚠ IT RIDES ON THIS RESULT AND ON THE RESPONSE **ENVELOPE**, NEVER ON `JoinGrant`.
       * Widening the grant would change `MeetingCallSurface`'s frozen five-prop contract and
       * both guest call sites; the envelope reaches only the member arm, which is the only
       * caller that has a dashboard to go back to.
       *
       * ⚠ MEMBER ARM ONLY. The guest and lobby arms deliberately do not carry it — Decision 9's
       * no-oracle rule governs those callers.
       */
      readonly context: MemberJoinContext;
      /**
       * BAL-435 (R10) — WHO IS MISSING, and when the meeting was due to start.
       *
       * ⚠⚠ `viewerRole` IS THE GATE'S OWN `side`, PASSED THROUGH. It exists because the in-call
       * waiting stage had no honest input and therefore hard-coded "expert" for every viewer —
       * showing the DELIVERING EXPERT the CLIENT's billing promise on a money surface.
       *
       * ⚠ MEMBER ARM ONLY, like `context`, and for the same reason: the guest and lobby arms are
       * anonymous or token-bearing, and Decision 9's no-oracle rule governs them.
       */
      readonly viewerRole: MeetingViewerRole;
      /** ⚠ `null` ⇒ the web layer renders party-NEUTRAL copy. Never a guess. */
      readonly counterpartyFirstName: string | null;
      /** ISO 8601. ⚠ Formatted in the VIEWER's timezone by the browser, never here. */
      readonly scheduledStart: string;
    }
  | { readonly ok: false; readonly code: JoinErrorCode };

export type GuestJoinResult =
  | { readonly ok: true; readonly state: 'admitted'; readonly grant: JoinGrant }
  | { readonly ok: true; readonly state: 'waiting' }
  | { readonly ok: false; readonly code: JoinErrorCode };

export type ClaimLobbyPlaceResult =
  | { readonly ok: true; readonly lobbyToken: string }
  | { readonly ok: false; readonly code: JoinErrorCode };

export interface JoinMeetingAsMemberInput {
  readonly meetingId: string;
  readonly userId: string;
  /** ⚠ THE INJECTION POINT. The route passes nothing; tests pass an object literal. */
  readonly minter?: MeetingTokenMinter;
}

export interface JoinMeetingAsGuestInput {
  readonly meetingId: string;
  readonly rawGuestToken: string;
  readonly minter?: MeetingTokenMinter;
}

export interface ClaimLobbyPlaceInput {
  readonly meetingId: string;
  readonly name: string;
  readonly email: string;
}

/** What a guest with no name of their own is called — the literal the join page uses. */
const ANONYMOUS_GUEST_LABEL = 'Guest';

/** What a member with no first or last name is called. ⚠ NEVER their email address. */
const ANONYMOUS_MEMBER_LABEL = 'Participant';

/** The admissions that mint. `pending` waits; `denied` never reaches here (filtered). */
const ADMITTED_STATES: ReadonlySet<MeetingGuestAdmission> = new Set(['pre_admitted', 'admitted']);

/** The single fail-closed exit. The SHAPE goes to the log; the wire gets one literal. */
function deny(
  code: JoinErrorCode,
  reason: string,
  fields: Record<string, unknown>
): { readonly ok: false; readonly code: JoinErrorCode } {
  log.warn({ ...fields, reason, code }, 'Meeting join denied');
  return { ok: false, code };
}

/**
 * The meeting's VENUE, or a failure. ⚠ REQUIRES **BOTH** COLUMNS.
 *
 * `rooms.ts` argues a half-stamped row is unproducible through its seam, and it is right —
 * but this route must not assume it, because a `provisioned: false` meeting (a real `201`
 * outcome of `POST /meetings` when Daily was down) has BOTH columns null and is
 * indistinguishable here from a hypothetical half-stamped one.
 *
 * ⚠ AND IT VERIFIES THE STAMPED NAME AGAINST THE DERIVED ONE. The name is a pure function of
 * `meetings.id`, so there is exactly one correct value; a divergence means the room this
 * token would admit you to is NOT the room the meeting is in, and everyone would sit alone in
 * separate rooms wondering where the other party is. This is the only place that divergence
 * is visible, and it costs one string comparison.
 */
function resolveVenue(meeting: {
  id: string;
  joinUrl: string | null;
  dailyRoomName: string | null;
}):
  | { readonly ok: true; readonly roomUrl: string; readonly roomName: string }
  | { readonly ok: false } {
  const { joinUrl, dailyRoomName } = meeting;
  if (joinUrl === null || dailyRoomName === null) {
    log.warn(
      { meetingId: meeting.id, hasJoinUrl: joinUrl !== null, hasRoomName: dailyRoomName !== null },
      'Meeting is not provisioned — refusing to mint'
    );
    return { ok: false };
  }

  const expected = dailyRoomNameForMeeting(meeting.id);
  if (dailyRoomName !== expected) {
    // ⚠ `error`, not `warn`: this is a data anomaly, not a user mistake. Both values are
    // meeting-derived and neither is a secret.
    log.error(
      { meetingId: meeting.id, expected, stamped: dailyRoomName },
      'Stamped Daily room name disagrees with the derived one — refusing to mint'
    );
    return { ok: false };
  }

  return { ok: true, roomUrl: joinUrl, roomName: dailyRoomName };
}

/**
 * Mint, mapping every vendor failure onto ONE literal.
 *
 * ⚠⚠ NEVER ECHO `err.message`. `DailyApiError` carries the vendor's raw body AND the
 * requested room name — which is a pure function of `meetings.id`, i.e. a raw uuid. Both go
 * to `log.error` with the meeting id and nowhere else; the wire gets
 * `meeting_token_unavailable`.
 *
 * ⚠ `DailyConfigError` (a missing `DAILY_API_KEY`) lands here too rather than 500-ing with a
 * stack. A misconfiguration is an outage, and an outage is a 503 with a legible literal.
 */
async function mint(
  minter: MeetingTokenMinter,
  request: {
    meetingId: string;
    roomName: string;
    userName: string;
    participantId: string;
    isOwner: boolean;
    expiresAtUnix: number;
  }
): Promise<{ readonly ok: true; readonly token: string } | { readonly ok: false }> {
  try {
    const minted = await minter.createMeetingToken({
      roomName: request.roomName,
      userName: request.userName,
      participantId: request.participantId,
      isOwner: request.isOwner,
      expiresAtUnix: request.expiresAtUnix,
    });
    return { ok: true, token: minted.token };
  } catch (error) {
    log.error(
      {
        meetingId: request.meetingId,
        isOwner: request.isOwner,
        errorName: error instanceof Error ? error.name : 'unknown',
        status: error instanceof DailyApiError ? error.status : undefined,
        // ⚠ SERVER-SIDE ONLY. `DailyApiError.body` is the vendor's raw text.
        body: error instanceof DailyApiError ? error.body : undefined,
        error: error instanceof Error ? error.message : String(error),
        // ⚠ THE STACK IS REQUIRED, NOT OPTIONAL. CLAUDE.md's rule is message + stack +
        // contextual ids in every catch that HANDLES rather than re-throws — and this is the
        // only such catch in the file: everything else propagates, so if this line is thin the
        // original failure is gone for good. The wire still gets only
        // `meeting_token_unavailable`; the route's own catch already logs a stack, and the two
        // now agree.
        stack: error instanceof Error ? error.stack : undefined,
      },
      error instanceof DailyConfigError
        ? 'Daily is not configured — cannot mint a meeting token'
        : 'Daily meeting token mint failed'
    );
    return { ok: false };
  }
}

/**
 * ⚠ AN AUTHENTICATED MEMBER JOINS. Every step below is load-bearing; the ORDER is contract.
 */
export async function joinMeetingAsMember(
  input: JoinMeetingAsMemberInput
): Promise<JoinMeetingResult> {
  const { meetingId, userId } = input;
  const minter = input.minter ?? dailyMeetingTokenMinter;

  // 1. ⚠⚠ TENANCY. This gate — and NOT `resolveHostContext` — is what discharges it.
  //    `resolveHostContext` is an identity oracle with NO tenancy check, and
  //    `meeting_contexts.context_id` has no FK and no RLS, so calling it on an unvetted
  //    `meetingId` would answer questions about meetings the caller has no relationship to.
  //    Every denial collapses into one literal here.
  const authorized = await authorizeMeetingParticipation({ meetingId, userId });
  if (!authorized.ok) {
    return { ok: false, code: 'meeting_not_found' };
  }
  // ⚠ `side`, `companyId` and `expertProfileId` come from the GATE — they are what it already
  // resolved from the meeting's own primary context, so BAL-435's waiting-stage data costs no
  // second tenancy decision and no re-read of the context row.
  const { meeting, subject, side, companyId, expertProfileId } = authorized;

  // 2. LIVENESS — meeting state + engagement lifecycle + the token window. Safe as a
  //    DISTINCT literal only because step 1 already proved this actor belongs here.
  const liveness = await assertMeetingJoinable(meeting, subject);
  if (!liveness.ok) {
    return deny('meeting_not_open_for_join', liveness.reason, { meetingId, userId });
  }

  // 3. THE VENUE. A `provisioned: false` meeting is a real `201` outcome of `POST /meetings`.
  //    ⚠ THIS ROUTE DOES NOT PROVISION ON DEMAND — `provisionMeeting` is BAL-129's
  //    booking-time writer, and a second writer on `setVenue` here would be scope creep.
  const venue = resolveVenue(meeting);
  if (!venue.ok) {
    return deny('meeting_not_provisioned', 'no_venue', { meetingId, userId });
  }

  // 4. ⚠ OWNER RIGHTS AND END AUTHORITY, RESOLVED PER ACTOR. `resolveEndAuthority` runs the
  //    SECOND `resolveHostContext` of the request — the gate's expert arm already did one for
  //    `manage_engagement` — and that is correct and unavoidable, not waste:
  //    `HostContext.resolvedForActorId` is the confused-deputy brand, so a context is an answer
  //    about ONE actor and must be re-resolved per actor. `listGuests` already pays this cost.
  //    ⚠ NEVER `lens === 'expert'`, never a role comparison (ADR-1029).
  //
  //    ⚠⚠⚠ **`isOwner` AND `canEndMeeting` ARE TWO SEPARATE FIELDS AND MUST NEVER BE MERGED.**
  //    THIS IS THE SHARPEST TRAP IN BAL-134, so it is written at the line where it would be
  //    made: `isOwner` — and ONLY `isOwner` — is fed into `mint(...)` below, where it becomes
  //    the Daily meeting token's `is_owner` property. Daily `is_owner` confers VENDOR-LEVEL
  //    ROOM POWERS (eject, recording control). `canEndMeeting` is the OR of the engagement axis
  //    and a CLIENT-side membership token, so assigning it to `isOwner` — or "simplifying"
  //    these into one boolean — WOULD MINT DAILY OWNER TOKENS FOR THE PAYING SIDE. ADR-1049's
  //    "this is what BAL-435's bare `isOwner` prop becomes" is unsafe as written and is
  //    deliberately NOT implemented as a rename. See `join-grant.ts`'s six-field block.
  const [endAuthority, names] = await Promise.all([
    resolveEndAuthority({ userId, companyId, subject }),
    // ⚠ `findNamesByIds` PROJECTS FIRST AND LAST NAME ONLY. Never `findById` /
    // `findWithCompany`, which hydrate `workosId`, email and phone — and this value flows
    // into a token that reaches a browser (memory `reference_drizzle_with_hydration_leaks_secrets`).
    usersRepository.findNamesByIds([userId]),
  ]);
  // ⚠ THE ENGAGEMENT-AXIS HALF, REUSED RATHER THAN RE-RESOLVED. `resolveEndAuthority` already
  // asked `hasEngagementCapability(HOST_MEETINGS)`; asking again here would be a second
  // `resolveHostContext` on the same request AND a second answer that could disagree with the
  // one the End control was gated on.
  const isOwner = endAuthority.isExpertHost;

  const [person] = names;
  const userName = personDisplayName(
    person?.firstName ?? null,
    person?.lastName ?? null,
    // ⚠ NEVER fall back to the email address.
    ANONYMOUS_MEMBER_LABEL
  );

  const participantId = dailyParticipantIdFor('user', userId);
  // ⚠ THE LABEL AND COUNTERPARTY LOOKUPS RUN ALONGSIDE THE MINT, NOT AFTER IT. They are
  // independent, and the AC is join-to-talking under three seconds — a serial read here would be
  // a pure waterfall.
  // ⚠ NEITHER EVER THROWS (see their own modules), so `Promise.all` cannot reject on them.
  const [minted, context, counterpartyFirstName] = await Promise.all([
    mint(minter, {
      meetingId,
      roomName: venue.roomName,
      userName,
      participantId,
      isOwner,
      expiresAtUnix: liveness.expiresAtUnix,
    }),
    resolveMeetingContextLabel(subject),
    resolveWaitingCounterparty({ viewerRole: side, companyId, expertProfileId }),
  ]);
  if (!minted.ok) {
    return { ok: false, code: 'meeting_token_unavailable' };
  }

  trackServer(MEETING_SERVER_EVENTS.MEETING_JOIN_GRANTED, {
    meeting_id: meetingId,
    context_type: subject.contextType,
    is_owner: isOwner,
    distinct_id: userId,
  });
  log.info({ meetingId, userId, isOwner, kind: 'user' }, 'Meeting token minted');

  return {
    ok: true,
    grant: {
      roomUrl: venue.roomUrl,
      token: minted.token,
      // ⚠ THE MINT'S BOOLEAN — Daily owner rights. See step 4.
      isOwner,
      expiresAt: liveness.expiresAt.toISOString(),
      participantId,
      // ⚠ BAL-134 — A SEPARATE, SIXTH FIELD. Gates the End control only; never reaches Daily.
      canEndMeeting: endAuthority.canEndMeeting,
    },
    context,
    // ⚠ R10 — the waiting stage's only honest inputs. `viewerRole` is the GATE's verdict, never
    // a lens; `scheduledStart` is an instant, formatted in the viewer's own timezone by the
    // browser.
    viewerRole: side,
    counterpartyFirstName,
    scheduledStart: meeting.scheduledStart.toISOString(),
  };
}

/**
 * ⚠ A TOKEN-BEARING GUEST MINTS, OR IS TOLD TO WAIT. Serves BOTH the `pre_admitted` invitee
 * (mints on the first call — the AC's "no visible token step") and the `pending` lobby
 * visitor (polls until a host admits).
 */
export async function joinMeetingAsGuest(input: JoinMeetingAsGuestInput): Promise<GuestJoinResult> {
  const { meetingId, rawGuestToken } = input;
  const minter = input.minter ?? dailyMeetingTokenMinter;

  // 1. RESOLVE THE TOKEN. `findLiveByTokenHash` already filters not-deleted, not-revoked,
  //    not-expired, admission NOT `denied`, meeting not deleted and meeting not cancelled —
  //    which is why a DENIED token can never reach a mint on any path.
  const tokenHash = hashGuestToken(rawGuestToken);
  const row = await meetingGuestsRepository.findLiveByTokenHash(tokenHash);
  // ⚠ A HASH PREFIX ONLY in any log below — enough to correlate, never enough to replay.
  const tokenHashPrefix = tokenHash.slice(0, 8);

  if (row === undefined || !guestTokenHashesMatch(tokenHash, row.guest.tokenHash)) {
    return deny('meeting_not_found', 'unresolvable_token', { meetingId, tokenHashPrefix });
  }
  const { guest, meeting } = row;

  // 2. ⚠ THE TOKEN'S MEETING MUST BE THE URL'S MEETING. A token for meeting A presented at
  //    meeting B's URL must not resolve — otherwise one valid guest credential would be a
  //    universal probe for "is this uuid a meeting?".
  if (guest.meetingId !== meetingId) {
    return deny('meeting_not_found', 'token_meeting_mismatch', { meetingId, tokenHashPrefix });
  }

  // 3. The primary context. Not resolvable ⇒ `meeting_not_found` — which is also what makes
  //    an ADMIN-only meeting unjoinable for a guest.
  const primary = selectPrimaryMeetingContext(
    await meetingContextsRepository.listByMeeting(meetingId)
  );
  if (!primary.ok) {
    return deny('meeting_not_found', `context_${primary.reason}`, { meetingId, tokenHashPrefix });
  }

  const liveness = await assertMeetingJoinable(meeting, primary.context);
  if (!liveness.ok) {
    return deny('meeting_not_open_for_join', liveness.reason, { meetingId, guestId: guest.id });
  }

  // 4. ⚠⚠ THE ADMISSION SWITCH — DECISION 2. A `pending` guest gets `waiting` and NOTHING
  //    ELSE HAPPENS: no mint, no analytics, no write, no side effect of any kind. That
  //    absence IS the waiting-to-join queue.
  if (!ADMITTED_STATES.has(guest.admission)) {
    return { ok: true, state: 'waiting' };
  }

  const venue = resolveVenue(meeting);
  if (!venue.ok) {
    return deny('meeting_not_provisioned', 'no_venue', { meetingId, guestId: guest.id });
  }

  const participantId = dailyParticipantIdFor('guest', guest.id);
  const minted = await mint(minter, {
    meetingId,
    roomName: venue.roomName,
    userName: guest.name ?? ANONYMOUS_GUEST_LABEL,
    participantId,
    // ⚠⚠ A GUEST IS NEVER A HOST. UNCONDITIONALLY false — including for a guest whose stored
    // `party` is `expert`, which is an EXPERT-SIDE COLLEAGUE, not the delivering expert.
    // Owner rights are the engagement axis's answer about delivery identity, and a guest row
    // is not on that axis at all. Pinned by a test.
    isOwner: false,
    expiresAtUnix: liveness.expiresAtUnix,
  });
  if (!minted.ok) {
    return { ok: false, code: 'meeting_token_unavailable' };
  }

  const joinMethod = joinMethodFor(guest.inviteChannel);
  trackServer(GUEST_SERVER_EVENTS.GUEST_JOINED, {
    // ⚠⚠ THE `party` KEY IS **OMITTED ENTIRELY** ON A LINK-SHARE JOIN — not sent as `null`,
    // and not sent as the stored value. `meeting_guests.party` is NOT NULL and CHECK-narrowed
    // to `client | expert`, so `claimLobbyPlace` stores the PLACEHOLDER `client` — not because
    // a side was resolved (a bare meeting URL carries no sharer identity) but because the
    // column demands something. Emitting that placeholder makes a dashboard filtered on
    // `party = client` silently include every link-share joiner, i.e. WRONG rather than merely
    // coarse.
    //
    // ⚠ A CONDITIONAL SPREAD, NOT `party: cond ? x : null` — which is what this line used to be
    // while its comment claimed the property was "ABSENT". It was not: `trackServer` spreads
    // this object straight into `capture({ properties })`, so the `null` reached PostHog as a
    // real value that satisfies `party is set` and creates a `null` breakdown bucket. A key
    // that is never set cannot do either.
    ...(joinMethod === 'link_share' ? {} : { party: guest.party as MeetingGuestSide }),
    join_method: joinMethod,
    // `true` = came through the QUEUE (a host explicitly decided); `false` = trust-by-default.
    admitted: guest.admission === 'admitted',
    // ⚠ `meeting_guests.id` — a guest has NO user id.
    distinct_id: guest.id,
  });
  log.info({ meetingId, guestId: guest.id, isOwner: false, kind: 'guest' }, 'Meeting token minted');

  return {
    ok: true,
    state: 'admitted',
    grant: {
      roomUrl: venue.roomUrl,
      token: minted.token,
      isOwner: false,
      expiresAt: liveness.expiresAt.toISOString(),
      participantId,
      // ⚠⚠ BAL-134 — A GUEST MAY NEVER END A MEETING. UNCONDITIONALLY false, hard-coded here
      // exactly as `isOwner` is, and for a reason of the same shape: a guest holds no
      // `company_members` row (so every membership token fails closed) and is not on the
      // engagement axis at all. They see Leave only — the ADR's intent, delivered structurally
      // rather than by a token check. Pinned by a test.
      canEndMeeting: false,
    },
  };
}

/**
 * ⚠ DERIVED FROM THE PERSISTED COLUMN, NEVER FROM REQUEST INPUT. `email` means somebody with
 * rights named this address; `link` means the link was forwarded.
 */
function joinMethodFor(inviteChannel: MeetingGuest['inviteChannel']): GuestJoinMethod {
  return inviteChannel === 'link' ? 'link_share' : 'magic_link';
}

/**
 * ⚠⚠ AN ANONYMOUS VISITOR KNOCKS. THE ONLY UNAUTHENTICATED WRITE PATH IN THIS FEATURE.
 *
 * ⚠ EVERY FAILURE ANSWERS `meeting_not_found`, INCLUDING THE ONES THAT WOULD BE DISTINCT
 * CODES ON THE MEMBER ARM. See the module docblock: the caller is anonymous and holding a
 * uuid they may have guessed, so "cancelled" vs "no such meeting" vs "the room is full" is an
 * existence oracle over every meeting on the platform. This is the one place the collapse is
 * WIDENED rather than narrowed, and it is deliberate.
 */
export async function claimLobbyPlace(input: ClaimLobbyPlaceInput): Promise<ClaimLobbyPlaceResult> {
  const { meetingId } = input;
  // ⚠ THROUGH THE SHARED `canonicalEmail`, NOT A SECOND DEFINITION. The partial unique index
  // `meeting_guest_meeting_email_live_idx` matches the STORED BYTES, which is what makes ONE
  // ADDRESS worth at most ONE queue row. It is NOT the only bound on a flood — `MAX_LOBBY_QUEUE`
  // below bounds the queue across all addresses, and the route's windows bound the rate.
  const email = canonicalEmail(input.email);
  const name = input.name.trim();

  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    return deny('meeting_not_found', 'no_meeting', { meetingId });
  }

  const primary = selectPrimaryMeetingContext(
    await meetingContextsRepository.listByMeeting(meetingId)
  );
  if (!primary.ok) {
    return deny('meeting_not_found', `context_${primary.reason}`, { meetingId });
  }

  const liveness = await assertMeetingJoinable(meeting, primary.context);
  if (!liveness.ok) {
    // ⚠ NOT `meeting_not_open_for_join`. Anonymity, not tidiness — see the docblock.
    return deny('meeting_not_found', liveness.reason, { meetingId });
  }

  // ── ⚠⚠ TWO CAPS, ON TWO DIFFERENT RESOURCES. THEY ARE NOT INTERCHANGEABLE. ──────────────
  //
  // `countLiveByMeeting` counts SEATS — `pre_admitted` or `admitted` guests who are actually
  // going to be in the room. `countPendingLobbyKnocks` counts QUEUE SLOTS — anonymous knocks
  // awaiting a decision. The first cut used ONE counter for both, and a knock consumed a seat
  // the moment it landed, so:
  //   · 8 knocks from one address filled the meeting and the HOST could no longer invite
  //     anybody by email (`inviteGuests` shares this counter), and
  //   · denying them did not help, because a denied row still counted.
  // Splitting them means a knock flood can exhaust the QUEUE and nothing else, and that a
  // deny frees the slot it took with no second write.
  //
  // ⚠ BOTH ARE SOFT: two racing knocks at the boundary can both pass, the same accepted
  // looseness `inviteGuests` documents. Do not add an advisory lock.
  //
  // ⚠ ONE ROUND TRIP, NOT TWO IN SEQUENCE — this is a public, unauthenticated path and the
  // two counts are independent.
  const [liveGuests, queuedKnocks] = await Promise.all([
    meetingGuestsRepository.countLiveByMeeting(meetingId),
    meetingGuestsRepository.countPendingLobbyKnocks(meetingId),
  ]);
  if (liveGuests + RESERVED_BASE_PARTICIPANTS >= MAX_MEETING_PARTICIPANTS) {
    return deny('meeting_not_found', 'participant_cap_reached', { meetingId, liveGuests });
  }
  if (queuedKnocks >= MAX_LOBBY_QUEUE) {
    // ⚠ SAME UNIFORM LITERAL. "The queue is full" is a fact about a meeting an anonymous
    // holder of a guessed uuid must not learn — see the docblock.
    return deny('meeting_not_found', 'lobby_queue_full', { meetingId, queuedKnocks });
  }

  const { rawToken, tokenHash } = mintGuestInviteToken();
  const claimed = await meetingGuestsRepository.claimLobbyPlace({
    meetingId,
    email,
    name: name.length === 0 ? null : name,
    emailDomain: extractEmailDomain(email),
    // ⚠⚠ A PLACEHOLDER, NOT A RESOLVED SIDE (Decision 3). `meeting_guests.party` is NOT NULL
    // and CHECK-narrowed to `client | expert`, and a bare meeting URL carries no sharer
    // identity — so there is nothing to resolve. IT MUST NEVER ANCHOR MONEY, and it cannot:
    // `presencePartyForGuest` maps the whole `link` channel to presence `observer`
    // regardless of what is stored here, by a NON-OPTIONAL argument.
    party: 'client',
    // A knock grants the ONE meeting. `engagement` scope is a domain-match grant that only
    // an inviter can confer.
    accessScope: 'meeting',
    tokenHash,
    // ⚠ REUSED, NEVER RE-DERIVED. Deliberately LONGER than the Daily token's 24h: the row is
    // the HANDLE, the Daily token is the ENTRY.
    expiresAt: new Date(meeting.scheduledEnd.getTime() + GUEST_TOKEN_TTL_AFTER_END_MS),
  });

  if (claimed === undefined) {
    // ⚠⚠ A LIVE ROW ALREADY EXISTS FOR THIS (MEETING, EMAIL), IN **ANY** ADMISSION STATE, AND
    // NOTHING WAS MUTATED. The insert is `ON CONFLICT DO NOTHING`, so a stranger who guesses
    // a colleague's address cannot rotate that person's live token out from under them, nor
    // inherit their queue position under a name of the stranger's choosing.
    //
    // ⚠ `pending`, `admitted`, `pre_admitted` AND `denied` ALL LAND HERE, on ONE literal —
    // which is a narrowing: the earlier compare-and-set answered `201` for a live `pending`
    // incumbent and `404` for the rest, i.e. it told the caller which one it was.
    //
    // ⚠ THE RESIDUAL, STATED: success-vs-refusal still distinguishes "this address has a live
    // row on this meeting" from "it does not". See `claimLobbyPlace`'s repository docblock for
    // why that is accepted and what closing it would cost.
    return deny('meeting_not_found', 'claim_conflicts_with_live_row', { meetingId });
  }

  log.info({ meetingId, guestId: claimed.id }, 'Lobby place claimed');

  // ⚠ THE RAW TOKEN GOES BACK TO ITS BEARER, AND THIS DOES **NOT** BREACH BAL-408'S "THE RAW
  // TOKEN NEVER COMES BACK" CONTRACT — the first thing a reviewer will challenge, so it is
  // written down. That contract forbids returning an INVITE token to a HOST's UI so it can
  // build a join link for somebody else. Here the token was minted FOR the bearer and is
  // returned ONLY to the bearer, over the connection that just created it — structurally
  // identical to `mintGuestInviteToken`'s emailed raw token, which the contract explicitly
  // permits. It is never logged, never persisted (only its hash is), and never shown to a host.
  return { ok: true, lobbyToken: rawToken };
}
