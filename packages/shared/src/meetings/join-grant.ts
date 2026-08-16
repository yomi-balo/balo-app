/**
 * BAL-132 — THE JOIN CREDENTIAL'S SHAPE, DEFINED **ONCE**, ACROSS THE HTTP BOUNDARY.
 *
 * ⚠⚠ WHY THIS IS IN `@balo/shared` RATHER THAN DECLARED TWICE. `apps/api`'s join service
 * produces this object and `apps/web`'s join client consumes it, and until this module existed
 * the two declarations were linked BY A COMMENT ("Mirrors `JoinGrant` in `apps/api`") and by
 * nothing else. A comment is not a compile-time link: renaming `expiresAt`, widening `isOwner`
 * or dropping `participantId` on one side left the other side green, and the failure would
 * have surfaced as a browser holding a credential it could not use.
 *
 * The same object is spread into `MeetingCallSurface`'s five props at BOTH join call sites,
 * and **BAL-435 consumes exactly this shape** when it mounts the real Daily SDK — so one
 * definition is not tidiness, it is the contract that ticket builds against.
 *
 * ⚠ PURE AND DEPENDENCY-FREE, like every other member of this subpath. Types only: no
 * `@balo/db` value import can reach a `'use client'` module through here (memory
 * `reference_balo_db_client_bundle_footgun`).
 */

import type { MeetingContextTypeWithHolder } from './guest-participation';

/**
 * Everything needed to enter a Daily room, and nothing else.
 *
 * ⚠ THE ROOM IS `privacy: 'private'`. `roomUrl` admits nobody on its own; `token` is the ONLY
 * thing that admits anyone. Treat the pair accordingly.
 *
 * ── ⚠⚠ SIX FIELDS AS OF BAL-134, AND WHY THE TWO BOOLEANS MUST NEVER BE MERGED ────────────
 *
 * This grant carried FIVE fields from BAL-132 to BAL-436, and two comments in this file said
 * so in those words. **BAL-134 ADDED A SIXTH — {@link JoinGrant.canEndMeeting}** — so those
 * comments are now false; they are CORRECTED IN PLACE rather than deleted, because the reason
 * the sixth field is a SEPARATE field is the single sharpest trap in the feature:
 *
 *   · {@link JoinGrant.isOwner} is `hasEngagementCapability(HOST_MEETINGS)` and is the **ONLY**
 *     input to the Daily meeting token's `is_owner` property. `join-meeting.ts` feeds that
 *     exact boolean into the mint, and Daily `is_owner` confers VENDOR-LEVEL ROOM POWERS —
 *     eject and recording control. **Widening it to client principals would mint Daily owner
 *     tokens for the PAYING SIDE.** ADR-1049's "this is what BAL-435's bare `isOwner` prop
 *     becomes" is UNSAFE AS WRITTEN and must not be implemented as a rename.
 *   · {@link JoinGrant.canEndMeeting} is the OR of two independently-resolved axes
 *     (`@balo/shared/meetings`'s `canEndMeeting`, composed in `apps/api`'s
 *     `authorize-end-meeting.ts`). It gates ONE thing — whether the End control renders and
 *     whether `POST /meetings/:id/end` is accepted — and it NEVER reaches a Daily token.
 *
 * They diverge the moment the viewer is a client principal, which is the ordinary case for
 * every client-booked consultation. Neither is redundant, and neither may be derived from the
 * other. `apps/web`'s `meeting-call-no-lens-gate.test.ts` pins which control resolves on which.
 */
export interface JoinGrant {
  /** The Daily room URL. ⚠ Admits nobody on its own — the room is private. */
  readonly roomUrl: string;
  /**
   * ⚠⚠ THE DAILY JWT — A LIVE CREDENTIAL. Never log it, never persist it, never make it an
   * analytics property, never render it as copyable text, never put it in a URL.
   */
  readonly token: string;
  /**
   * The server's `hasEngagementCapability(HOST_MEETINGS)` verdict, resolved per actor.
   * ⚠ Gate host controls on THIS boolean — never on `activeMode`, a lens or a role string
   * (ADR-1029).
   */
  readonly isOwner: boolean;
  /**
   * ISO 8601 — the meeting's scheduled end + 24h.
   * ⚠ `eject_at_token_exp` is FALSE, so expiry does NOT eject anyone mid-call; it only
   * prevents a fresh join. Do not build a countdown that ends the call.
   */
  readonly expiresAt: string;
  /** The Decision-1 encoding — `u`/`g` + 32 hex. ⚠ Never a bare uuid. */
  readonly participantId: string;
  /**
   * BAL-134 / ADR-1049 (D3) — MAY THIS VIEWER END THE MEETING FOR EVERYONE?
   *
   * ⚠⚠ NOT `isOwner`, AND NOT DERIVABLE FROM IT. See the six-field block on this interface
   * before changing either. `true` for the delivering expert (and their agency owner/admin) OR
   * for a client principal — a live member of the BOOKING company holding `CONSUME_CREDITS`.
   * `false` unconditionally on both GUEST arms, hard-coded server-side exactly as `isOwner` is:
   * a guest holds no membership and is not on the engagement axis, so they see Leave only.
   *
   * ⚠ IT GATES THE **CONTROL**, NOT THE OUTCOME. `POST /meetings/:meetingId/end` re-resolves
   * both axes server-side on every call; this boolean exists so the UI does not render a
   * control that would 404. A browser that flips it gains nothing.
   */
  readonly canEndMeeting: boolean;
}

/**
 * BAL-435 (R6 / Q1) — the MEMBER join response's optional CONTEXT envelope.
 *
 * ⚠⚠ IT IS ON THE ENVELOPE, **NOT ON `JoinGrant`**, AND THAT IS THE WHOLE POINT OF THE RULING.
 * The grant carries only what is needed to ENTER THE ROOM, so `MeetingCallSurfaceProps` and both
 * guest call sites are untouched. The call surface's chrome (the top-bar `<h1>` and the
 * "Back to {context}" link) reads this through a route-scoped React Context instead — see
 * `apps/web/src/lib/meetings/meeting-route-context.tsx`.
 *
 * ⚠ BAL-435's WORDING HERE WAS "`JoinGrant` stays frozen at its five fields", AND THAT IS NOW
 * FALSE — BAL-134 added a sixth, `canEndMeeting`. The RULING is unchanged and still binding
 * (context data rides the envelope, not the grant); only the count was wrong. What earns a place
 * on the grant is a per-actor AUTHORIZATION verdict the call surface must hold to render safely;
 * what does not is descriptive context. See `JoinGrant`'s own six-field block for why the two
 * booleans are separate.
 *
 * ⚠ IT LEAKS NOTHING NEW. `apps/api` already resolves the primary context on this exact path —
 * it is where `MEETING_JOIN_GRANTED.context_type` is emitted from — and the caller only reaches
 * it after `authorizeMeetingParticipation` has already granted them the call.
 *
 * ⚠ AND IT IS **OPTIONAL** ON PURPOSE. The two GUEST surfaces (`/join/m/[meetingId]` and
 * `/join/[token]`) never receive it, so the web layer's `/dashboard` fallback is a LIVE path
 * rather than dead code.
 */
export interface MemberJoinContext {
  /** ⚠ `admin` is structurally unreachable — an admin meeting has no holder and 404s upstream. */
  readonly type: MeetingContextTypeWithHolder;
  readonly id: string;
  /**
   * A human label for the meeting, or `null`.
   *
   * ⚠⚠ `null` IS A FIRST-CLASS ANSWER, NOT A FAILURE. Balo has no `meetings.title` column, and
   * only two of the six holder-bearing context shapes carry a title reachable in one read
   * (`case_engagements.title` and `project_requests.title`). The three engagement-delivery
   * shapes have no title column anywhere, so they answer `null` and the UI renders its neutral
   * heading. Inventing one here would mean designing a title concept this ticket has no mandate
   * for; a wrong title on a live call is worse than no title.
   */
  readonly title: string | null;
}

/**
 * BAL-435 (ruling R10) — WHICH SIDE OF THE MEETING THE VIEWER WAS RESOLVED ONTO.
 *
 * ⚠⚠ IT IS THE **SERVER's** ANSWER, from `authorizeMeetingParticipation`'s two-axis gate, and it
 * is NEVER taken from request input, from `activeMode`, or from a lens. It is a delivery FACT
 * about the room ("who is missing"), not a view toggle — which is precisely why the waiting stage
 * may branch on it.
 */
export type MeetingViewerRole = 'client' | 'expert';

/**
 * The wire body of `POST /meetings/:meetingId/join`.
 *
 * ⚠ THE GRANT'S FIELDS ARE SPREAD AT THE TOP LEVEL, unchanged, so an older client that knows
 * nothing about `context` keeps working byte for byte. (It said "FIVE fields" until BAL-134
 * added `canEndMeeting`; the property being described is the SPREAD, not the count.)
 *
 * ⚠⚠ EVERYTHING BESIDE THE GRANT IS **OPTIONAL**, ON PURPOSE. The two GUEST surfaces
 * (`/join/m/[meetingId]`, `/join/[token]`) never receive any of it, so every "absent ⇒ neutral"
 * path in `apps/web` is a LIVE path rather than dead code — and a client that fails to parse one
 * of these degrades to neutral copy instead of losing the call.
 */
export interface MemberJoinResponse extends JoinGrant {
  readonly context?: MemberJoinContext;
  /**
   * BAL-435 (R10) — the viewer's resolved side, so the waiting stage knows WHO IS MISSING.
   *
   * ⚠ Without it the stage hard-coded `absentParty="expert"` for every viewer, which showed the
   * delivering EXPERT the CLIENT's billing promise ("You won't be charged for waiting") on a
   * money surface. Absent ⇒ the web layer renders party-neutral copy, never a guess.
   */
  readonly viewerRole?: MeetingViewerRole;
  /**
   * The name the waiting copy addresses — the OTHER party, resolved server-side.
   *
   * ⚠ ON THE CLIENT SIDE it is the DELIVERING EXPERT's first name: the expert side of a meeting
   * names exactly one individual, and that individual is who will actually join.
   * ⚠ ON THE EXPERT SIDE it is the CLIENT COMPANY's name, because the client side names no single
   * individual — the meeting records a company, not a person. CLAUDE.md's attribution rule wants
   * the party in prospective copy ("Northwind has 7 days to review"), so naming the company is
   * both the honest answer and the documented one. Never invent a person.
   * ⚠ `null` when it could not be resolved ⇒ neutral copy.
   */
  readonly counterpartyFirstName?: string | null;
  /**
   * ISO 8601 — the meeting's scheduled start, for the viewer-local "Due to start at {start}" line.
   *
   * ⚠ FORMATTED IN THE **VIEWER's** TIMEZONE ON THE CLIENT, never here: the server does not know
   * the browser's zone, and a start time stated in the wrong zone on a money surface is worse
   * than no start time at all.
   */
  readonly scheduledStart?: string;
}

/**
 * The guest mint/poll endpoint's discriminated success body.
 *
 * ⚠ `waiting` CARRIES NO GRANT, AND THAT ABSENCE IS THE WHOLE QUEUE (Decision 2). A `pending`
 * guest has no Daily token in existence anywhere; the moment a host admits, the SAME call
 * mints. Widening this union with a `denied` arm would turn the endpoint into an oracle — a
 * denied token resolves to the uniform `meeting_not_found` instead, by contract.
 */
export type GuestJoinState =
  | { readonly state: 'admitted'; readonly grant: JoinGrant }
  | { readonly state: 'waiting' };

/** The anonymous lobby claim's success body. `state` is present so the two bodies read alike. */
export interface LobbyClaimState {
  readonly state: 'waiting';
  /**
   * The 43-char base64url raw lobby token.
   *
   * ⚠ IT GOES BACK TO ITS BEARER AND NOWHERE ELSE. This does NOT breach BAL-408's "the raw
   * token never comes back" contract, which forbids returning an INVITE token to a HOST's UI
   * so it can build a link for somebody else — see `claimLobbyPlace`'s docblock in `apps/api`.
   */
  readonly lobbyToken: string;
}
