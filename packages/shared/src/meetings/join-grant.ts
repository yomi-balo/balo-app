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

/**
 * Everything needed to enter a Daily room, and nothing else.
 *
 * ⚠ THE ROOM IS `privacy: 'private'`. `roomUrl` admits nobody on its own; `token` is the ONLY
 * thing that admits anyone. Treat the pair accordingly.
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
