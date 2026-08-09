/**
 * BAL-129 — Daily room creation, and the `RoomProvisioner` port the meetings service
 * depends on.
 *
 * ⚠⚠ `privacy: 'private'` IS THE ENFORCEMENT MECHANISM (D8), NOT A SECOND LAYER BEHIND ONE.
 * Record this before "simplifying" it away:
 *
 *   ADR-1044's waiting-to-join queue is implemented APP-SIDE, in Balo's custom Call Object
 *   UI. A public room's raw `daily.co` URL — extractable from devtools by any participant —
 *   bypasses that queue ENTIRELY. PRIVATE ROOM CREATION IS WHAT MAKES THE QUEUE REAL.
 *
 *   It is also what makes meeting-id-derived room names safe: derivability is only
 *   acceptable because knowing the name buys nothing without a token. See
 *   `@balo/shared/meetings`'s `dailyRoomNameForMeeting`.
 *
 *   ⚠ WHICH IS WHY `createRoom` VERIFIES `privacy` ON THE RESPONSE rather than trusting the
 *   request — on both the create path AND the already-exists fallback, which does not send
 *   `privacy` at all. A declared-and-never-read field would have been a guarantee in name
 *   only. See `createRoom`.
 *
 * Two corollaries:
 *
 *   · Because Balo drives Daily through the CALL OBJECT SDK (custom UI), Daily's own
 *     knocking screen never renders. `privacy: 'private'` here changes the TOKEN
 *     REQUIREMENT, not the UX.
 *
 *   · BAL-129 DOES NOT MINT TOKENS (D9). Token minting, `exp = scheduled end + 24h`, the
 *     authenticated `user_id` claim and admit-time guest tokens are all BAL-132's. ⚠ AND
 *     THE REASONING MATTERS, so the next reader does not "tighten" it: DAILY DOES NOT EJECT
 *     ON TOKEN EXPIRY — `eject_at_token_exp` is false by default. A tight expiry would NOT
 *     throw anyone out of a live call; it would lock out a network-blip REJOIN at minute 61.
 *     Same conclusion as a naive reading, correct reasoning.
 *
 *   · Reschedule reuses the same `meetings` row and the SAME room, so tokens minted before a
 *     reschedule stay valid until OLD end + 24h. Same legitimate holders — document, do not
 *     engineer against. Re-mint ACs are appended to BAL-409 / BAL-411.
 *
 * ⚠ THE REQUEST BODY CARRIES TWO KEYS AND NOTHING ELSE. Every other Daily knob — `exp`,
 * `nbf`, `enable_knocking`, `enable_recording`, `enable_prejoin_ui`, `eject_at_room_exp` —
 * is deliberately left at Daily's default and is owned by BAL-132 (tokens, People tab) and
 * BAL-131 (webhooks). Do not set them speculatively; an earlier draft of this ticket set
 * `enable_knocking: false`, and that is exactly the kind of silent commitment ADR-1044 had
 * to walk back. `rooms.test.ts` deep-equals the body for that reason.
 */
import { dailyRequest } from './client.js';
import { DailyApiError } from './errors.js';

/**
 * What Daily returns from `POST /v1/rooms` and `GET /v1/rooms/{name}` (the fields we use).
 *
 * ⚠ EVERY FIELD IS OPTIONAL, AND THAT IS NOT PESSIMISM — IT IS THE TRUTH ABOUT THIS TYPE.
 * `client.ts`'s `dailyRequest` ends in a bare `as T`: nothing parses the body, so this
 * interface is an ASSERTION about a vendor payload, not a guarantee derived from one. Declaring
 * the fields as `string` would have been a lie that TypeScript then enforced downstream —
 * exactly how `joinUrl: undefined` reached `setVenue` and produced a half-stamped row.
 *
 * Typed this way, `createRoom` CANNOT return a `ProvisionedRoom` without narrowing both fields
 * first: the checks below are load-bearing for the TYPE, so deleting one is a compile error
 * rather than a silent regression.
 */
interface DailyRoomResponse {
  name?: string;
  url?: string;
  privacy?: string;
}

/** The one value `privacy` may hold for a room this function will hand back. */
const REQUIRED_PRIVACY = 'private';

/**
 * The status carried on every `DailyApiError` this module raises about a room the vendor
 * returned in a 2xx — a non-private one, or one missing a field we must persist.
 *
 * ⚠ IT IS DELIBERATELY NOT `400`. `createRoom`'s already-exists fallback branches on
 * `status === 400`, so reusing that would make a response-contract violation on the POST path
 * trigger a pointless `GET` probe. `0` reads as "no vendor status — this is OUR verdict on a
 * 2xx response", which is exactly what it is.
 */
const RESPONSE_CONTRACT_VIOLATION_STATUS = 0;

/** The venue a provisioned meeting is stamped with. */
export interface ProvisionedRoom {
  dailyRoomName: string;
  joinUrl: string;
}

/**
 * The seam the meetings service depends on, so the integration test (real Postgres) can run
 * WITHOUT A NETWORK and without a Daily account. Mirrors the injectable `LlmClient`
 * precedent in `services/transcript/llm/`.
 *
 * ⚠ THIS PORT EXISTS FOR THAT REASON. Do not remove it as "indirection" — deleting it makes
 * the DB half of this ticket unprovable offline.
 */
export interface RoomProvisioner {
  createRoom(name: string): Promise<ProvisionedRoom>;
}

/** One room as the vendor described it, plus which call described it (for the error). */
interface VendorRoom {
  room: DailyRoomResponse;
  method: 'POST' | 'GET';
  path: string;
}

/**
 * POST the room, falling back to a `GET` when the name is already taken.
 *
 * ⚠ THE ALREADY-EXISTS FALLBACK IS THE ONLY BRANCH, and it is what makes re-provisioning
 * safe. Daily answers `400` when a room name is taken; we then `GET` the name, and a `200`
 * is DIRECT PROOF the room is ours (the name is a pure function of `meetings.id`, so no
 * other meeting could have taken it). If the `GET` fails, the original `400` was something
 * else and must propagate unchanged.
 *
 * Branching on STATUS PLUS A SUCCESSFUL GET rather than on the vendor's error string is
 * deliberate: the string is not a stable contract.
 */
async function createOrFindRoom(name: string): Promise<VendorRoom> {
  try {
    const room = await dailyRequest<DailyRoomResponse>('POST', '/rooms', {
      name,
      privacy: REQUIRED_PRIVACY,
    });
    return { room, method: 'POST', path: '/rooms' };
  } catch (error) {
    if (!(error instanceof DailyApiError) || error.status !== 400) {
      throw error;
    }
    // The name is taken. If it is taken by US (it can only be), the GET returns the room.
    const path = `/rooms/${encodeURIComponent(name)}`;
    const room = await dailyRequest<DailyRoomResponse>('GET', path).catch(() => {
      // The 400 meant something other than already-exists — re-raise THAT, not this.
      throw error;
    });
    return { room, method: 'GET', path };
  }
}

/**
 * Create ONE **verified private** Daily room under the caller-supplied (meeting-derived) name.
 *
 * ⚠⚠ `privacy` IS ASSERTED ON **BOTH** PATHS, AND THAT ASSERTION IS THE D8 GUARANTEE ITSELF —
 * NOT A BELT-AND-BRACES CHECK. Sending `privacy: 'private'` on the POST proves nothing about
 * what came back, and the already-exists fallback does not send it AT ALL: it ADOPTS a room
 * that already exists under this meeting's name, whose privacy this code never chose. A room
 * can be public there for reasons entirely outside this file — created by hand in the Daily
 * dashboard, created under a domain whose default privacy is public, or created by a future
 * BAL-131/BAL-132 code path. Without this assertion `setVenue` would stamp it and the route
 * would hand back a `joinUrl` whose raw `daily.co` address needs no token and therefore
 * bypasses ADR-1044's app-side waiting-to-join queue ENTIRELY — the exact failure that
 * `privacy: 'private'` is the enforcement mechanism against, and that the derivable room name
 * (`@balo/shared/meetings`'s `dailyRoomNameForMeeting`) is only safe under.
 *
 * SO IT THROWS. A stamped-but-public room must fail LOUDLY: the booking still commits and the
 * route answers `201 provisioned: false` (a missing artefact), which is strictly better than a
 * working join URL to an unguarded room.
 *
 * ⚠⚠ AND THE SAME APPLIES TO `name` / `url` BEING PRESENT AT ALL — THIS IS WHAT MAKES A
 * HALF-STAMPED MEETING ROW UNPRODUCIBLE. `client.ts`'s `dailyRequest` ends in a bare `as T`
 * cast, so a 2xx body of `{ name, privacy: 'private' }` with NO `url` type-checks and yields
 * `joinUrl: undefined`. `updateLiveMeeting` builds its patch as `{ ...set, updatedAt }` and
 * Drizzle OMITS undefined keys — so `daily_room_name` would be stamped while `join_url` stayed
 * NULL, and `provisionMeeting`'s replay guard (which requires BOTH columns non-null) would then
 * read that meeting as unprovisioned FOREVER: every repair attempt re-GETs the room, re-stamps
 * the same one column, and never converges. Validating the response here is the only place that
 * can be closed, because it is the last point at which the missing field is still visible as a
 * missing field rather than as an absent SQL assignment.
 */
export async function createRoom(name: string): Promise<ProvisionedRoom> {
  const { room, method, path } = await createOrFindRoom(name);

  if (room.privacy !== REQUIRED_PRIVACY) {
    throw new DailyApiError(
      method,
      path,
      RESPONSE_CONTRACT_VIOLATION_STATUS,
      `Daily room '${name}' has privacy '${room.privacy}'; refusing to use a room that is not '${REQUIRED_PRIVACY}'`
    );
  }
  return {
    dailyRoomName: requireField(room.name, 'name', name, method, path),
    joinUrl: requireField(room.url, 'url', name, method, path),
  };
}

/**
 * Return `value` when it is a non-empty string; throw otherwise. Runs on BOTH the POST and the
 * GET-fallback paths, because both feed `meetingsRepository.setVenue` and both of its columns
 * are stamped together or not at all.
 *
 * ⚠ IT CHECKS THE RUNTIME TYPE, NOT JUST EMPTINESS. `DailyRoomResponse` is asserted, never
 * parsed (`client.ts`'s `as T`), so `undefined` here is not merely possible — it is exactly the
 * shape a vendor contract change would take, and TypeScript would report nothing about it.
 *
 * ⚠ THE REQUESTED NAME GOES IN THE MESSAGE, NEVER THE VALUE THAT FAILED. This text becomes
 * `DailyApiError.body`, which `provision-meeting.ts` logs SERVER-SIDE and no response echoes;
 * the requested name is the actionable half (it re-derives the meeting), and the missing value
 * is by definition not worth printing.
 */
function requireField(
  value: string | undefined,
  field: 'name' | 'url',
  requestedName: string,
  method: 'POST' | 'GET',
  path: string
): string {
  if (value !== undefined && value.length > 0) {
    return value;
  }
  throw new DailyApiError(
    method,
    path,
    RESPONSE_CONTRACT_VIOLATION_STATUS,
    `Daily returned a room for '${requestedName}' with no usable '${field}'; refusing to stamp a half-provisioned meeting`
  );
}

/** The live implementation of the port. Tests substitute their own object literal. */
export const dailyRoomProvisioner: RoomProvisioner = { createRoom };
