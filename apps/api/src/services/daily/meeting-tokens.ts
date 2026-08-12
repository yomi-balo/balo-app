/**
 * BAL-132 — Daily MEETING TOKEN minting, and the `MeetingTokenMinter` port the join service
 * depends on. The sibling of `rooms.ts`, and deliberately its mirror image in every
 * structural respect.
 *
 * ⚠⚠ THIS IS THE THING THAT MAKES A PRIVATE ROOM ENTERABLE, AND NOTHING ELSE IS. `rooms.ts`
 * creates every room `privacy: 'private'`, which means the raw `daily.co` URL admits NOBODY:
 * knowing the room name (a pure function of `meetings.id`) buys nothing. A token minted HERE
 * is the ONLY key. Two consequences worth stating before anyone edits this file:
 *
 *   · EVERY authorization decision in the product is enforced at the moment this function is
 *     called, not by anything Daily does. `join-meeting.ts` is where that happens.
 *   · ADR-1044's waiting-to-join queue is REAL because a `pending` guest never reaches this
 *     call. "The queue enforces via token issuance, not UI" is implemented as: no mint.
 *
 * ── ⚠ THE REQUEST BODY CARRIES FIVE `properties` KEYS AND NOTHING ELSE (Decision 13) ─────
 *
 * `room_name`, `user_name`, `user_id`, `is_owner`, `exp`. An earlier draft of this ticket
 * also sent `enable_screenshare: true`, `start_audio_off: false` and `start_video_off: false`.
 * ALL THREE ARE DAILY'S OWN DEFAULTS, and all three are BAL-435's UI concerns — sending them
 * turns a default into a silent product commitment that a later ticket then has to discover
 * and walk back. `rooms.ts` records exactly this discipline for room creation ("an earlier
 * draft set `enable_knocking: false`, and that is exactly the kind of silent commitment
 * ADR-1044 had to walk back"), and `meeting-tokens.test.ts` DEEP-EQUALS the body for the same
 * reason a `objectContaining` would not do.
 *
 * ⚠⚠ `eject_at_token_exp` IS LEFT AT ITS DEFAULT OF `false` AND MUST STAY THERE. The whole
 * "expire at scheduled end + 24h" reasoning depends on Daily NOT ejecting on expiry: the
 * generous window exists so a network-blip REJOIN at minute 61 still works, and a token that
 * ejected would instead throw a live participant out of a call mid-sentence at exactly the
 * wrong moment. Setting it `true` converts a rejoin allowance into a mid-call ejection. It is
 * absent from the body, and a test asserts that absence.
 *
 * ⚠ REST, NOT THE SDK, and BARE `fetch` via `dailyRequest` rather than `loggedFetch` — both
 * inherited from `client.ts`, whose docblock argues them. `loggedFetch` is an `apps/web`
 * seam; `apps/api` has no equivalent and this ticket does not invent one. The failure is
 * logged at the route boundary with the meeting id attached.
 *
 * ⚠ NO RETRY, same ruling as `client.ts`. This call sits inside a request a human is staring
 * at while trying to join a call that is starting now; a retry buys no correctness (minting
 * is not idempotent-by-name the way room creation is — a second call just makes a second
 * valid token) and only extends their wait.
 */
import { dailyRequest } from './client.js';
import { DailyApiError } from './errors.js';

/**
 * What Daily returns from `POST /v1/meeting-tokens` (the one field we use).
 *
 * ⚠ THE FIELD IS OPTIONAL, AND THAT IS NOT PESSIMISM — IT IS THE TRUTH ABOUT THIS TYPE, for
 * exactly the reason `DailyRoomResponse` gives: `client.ts`'s `dailyRequest` ends in a bare
 * `as T`, so nothing parses the body and this interface is an ASSERTION about a vendor
 * payload rather than a guarantee derived from one. Declaring `token: string` would be a lie
 * TypeScript then enforces downstream — and downstream here is a browser being handed
 * `undefined` as its credential, which surfaces as an inscrutable Daily join failure two
 * layers away from the cause.
 *
 * Typed this way, `createMeetingToken` CANNOT return a `MintedMeetingToken` without narrowing
 * first, so the check below is load-bearing for the TYPE and deleting it is a compile error.
 */
interface DailyMeetingTokenResponse {
  token?: string;
}

/**
 * The status carried on every `DailyApiError` this module raises about a 2xx response whose
 * CONTENT we refuse.
 *
 * ⚠ DELIBERATELY NOT A REAL HTTP STATUS, and `0` specifically — the same sentinel and the
 * same reasoning as `rooms.ts`: it reads as "no vendor status; this is OUR verdict on a 2xx
 * response", which is exactly what it is. (`rooms.ts` additionally needs it to not be `400`
 * because it branches on that; there is no such branch here, but keeping the two modules'
 * sentinels identical is worth more than a locally-optimal choice.)
 */
const RESPONSE_CONTRACT_VIOLATION_STATUS = 0;

/** Everything the vendor needs to mint one token. Every field is decided by the CALLER. */
export interface MeetingTokenRequest {
  /**
   * ⚠ FROM `dailyRoomNameForMeeting`, NEVER HAND-BUILT. A token minted for a room name that
   * disagrees with the stamped `meetings.daily_room_name` is a credential to a room nobody is
   * in — and the name is a pure function of `meetings.id`, so there is exactly one right
   * answer and one place that knows it.
   */
  readonly roomName: string;
  /** The display name Daily shows other participants. Never an email address. */
  readonly userName: string;
  /**
   * ⚠ THE DECISION-1 ENCODING (`u`/`g` + 32 hex), from `dailyParticipantIdFor` — NEVER a bare
   * uuid. BAL-131's webhook resolver and BAL-134's presence writer route this value to
   * `meeting_presence.user_id` vs `meeting_guest_id`, two columns held apart by a CHECK, and
   * an untagged uuid is ambiguous between them. See `@balo/shared/meetings`.
   */
  readonly participantId: string;
  /**
   * Daily OWNER rights. ⚠ THE `hasEngagementCapability(HOST_MEETINGS)` VERDICT, resolved per
   * actor — never `lens === 'expert'`, never a role comparison (ADR-1029). ALWAYS `false` for
   * a guest, unconditionally, including a guest whose stored `party` is `expert`.
   */
  readonly isOwner: boolean;
  /**
   * ⚠ UNIX **SECONDS**, WHICH IS DAILY'S UNIT AND NOT JAVASCRIPT'S. A milliseconds value
   * here is silently accepted by the vendor and produces a token expiring roughly 50,000
   * years out — a catastrophic, invisible failure. `meeting-liveness.ts` computes this and
   * its tests assert the unit explicitly.
   */
  readonly expiresAtUnix: number;
}

/** One minted credential. */
export interface MintedMeetingToken {
  /**
   * ⚠⚠ THE DAILY JWT. NEVER LOG IT, NEVER PERSIST IT, NEVER PUT IT IN AN AUDIT ROW OR AN
   * ANALYTICS PROPERTY. It travels from this function, through the join service, to the ONE
   * browser that authenticated for it, and nowhere else. Same posture as the raw guest invite
   * token in `lib/guest-token.ts`.
   */
  readonly token: string;
}

/**
 * The seam `services/meetings/join-meeting.ts` depends on, so its unit tests and the route
 * tests run WITHOUT A NETWORK AND WITHOUT A DAILY ACCOUNT. Mirrors `RoomProvisioner`, which
 * in turn mirrors the injectable `LlmClient` precedent in `services/transcript/llm/`.
 *
 * ⚠ THIS PORT EXISTS FOR THAT REASON. Do not remove it as "indirection" — deleting it makes
 * the join route, which is the entire authorization surface of this feature, unprovable
 * offline. Every authorization decision in BAL-132 is expressed as "was this called, and with
 * what `isOwner`", and a test can only ask that question through a substitutable port.
 */
export interface MeetingTokenMinter {
  createMeetingToken(request: MeetingTokenRequest): Promise<MintedMeetingToken>;
}

/**
 * Mint ONE Daily meeting token.
 *
 * ⚠ THE BODY IS BUILT INLINE AND EXHAUSTIVELY HERE, not spread from the request object. A
 * spread would let a future field added to `MeetingTokenRequest` reach the vendor silently;
 * naming all five keys means the deep-equal test in `meeting-tokens.test.ts` is the gate on
 * what Daily is ever told.
 */
export async function createMeetingToken(
  request: MeetingTokenRequest
): Promise<MintedMeetingToken> {
  const path = '/meeting-tokens';
  const response = await dailyRequest<DailyMeetingTokenResponse>('POST', path, {
    properties: {
      room_name: request.roomName,
      user_name: request.userName,
      user_id: request.participantId,
      is_owner: request.isOwner,
      exp: request.expiresAtUnix,
    },
  });

  return { token: requireToken(response.token, request.roomName, path) };
}

/**
 * Return the token when the vendor actually sent one; throw otherwise.
 *
 * ⚠ IT CHECKS THE RUNTIME TYPE, NOT JUST EMPTINESS — `DailyMeetingTokenResponse` is asserted,
 * never parsed (`client.ts`'s `as T`), so `undefined` here is not merely possible: it is
 * exactly the shape a vendor contract change would take, and TypeScript would report nothing.
 * Without this, `token: undefined` reaches a browser as its credential.
 *
 * ⚠⚠ THE MESSAGE NAMES THE **ROOM**, NEVER THE TOKEN — and never the value that failed.
 * Same rule as `rooms.ts`'s `requireField`. This text becomes `DailyApiError.body`, which the
 * join route logs SERVER-SIDE and no response ever echoes; the room name is the actionable
 * half (it re-derives the meeting), and a credential has no business in an error string even
 * one that only reaches a log.
 */
function requireToken(value: string | undefined, roomName: string, path: string): string {
  if (value !== undefined && value.length > 0) {
    return value;
  }
  throw new DailyApiError(
    'POST',
    path,
    RESPONSE_CONTRACT_VIOLATION_STATUS,
    `Daily returned a meeting token for room '${roomName}' with no usable 'token'; refusing to hand back an empty credential`
  );
}

/** The live implementation of the port. Tests substitute their own object literal. */
export const dailyMeetingTokenMinter: MeetingTokenMinter = { createMeetingToken };

/*
 * ⚠ THERE IS DELIBERATELY NO `export { dailyRoomNameForMeeting }` HERE.
 *
 * One was added on the theory that re-exporting it beside the port would stop a call site
 * hand-building the room name. It never had an importer: BOTH mint call sites
 * (`join-meeting.ts`, `provision-meeting.ts`) take it from `@balo/shared/meetings`, which is
 * its actual home. A second import path for one pure function is not a safeguard — it is the
 * thing that makes "which one did this file mean?" a question. The rule it was protecting is
 * enforced where it belongs instead: on `MeetingTokenRequest.roomName`'s own docblock above,
 * and by `resolveVenue`, which refuses to mint when the stamped name disagrees with the
 * derived one.
 */
