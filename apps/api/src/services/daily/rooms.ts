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
 * ⚠ THE REQUEST BODY CARRIES THREE KEYS AND NOTHING ELSE (BAL-473 widened this from two).
 * Every other Daily knob — `exp`, `nbf`, `enable_knocking`, `enable_prejoin_ui`,
 * `eject_at_room_exp` — is deliberately left at Daily's default and is owned by BAL-132
 * (tokens, People tab) and BAL-131 (webhooks). Do not set them speculatively; an earlier
 * draft of this ticket set `enable_knocking: false`, and that is exactly the kind of silent
 * commitment ADR-1044 had to walk back. `rooms.test.ts` deep-equals the body for that reason.
 *
 * ⚠ WHY `enable_recording` EARNED ITS WAY IN (BAL-473, D5), AND NO OTHER KNOB DOES. D5 makes
 * Daily cloud recording an ALWAYS-ON PLATFORM GUARANTEE for every consultation that reaches
 * `in_progress` — not a per-room preference, not a speculative product commitment, and not a
 * thing a future ticket might turn on per meeting or per expert. That is a categorically
 * different kind of knob from `enable_knocking`/`enable_prejoin_ui`: those are UX toggles
 * this file has no business pre-deciding, while `enable_recording` is a platform-wide
 * invariant this file is the ONLY place that provisions a room at all. See
 * `services/daily/recordings.ts` for the rest of the recording pipeline and
 * `.claude/skills/mux/SKILL.md` for where the captured source goes.
 *
 * ⚠⚠ FIX ROUND 2 (R1) — `reconcileRoomRecording` DOES NOT CLOSE THE PRE-DEPLOY GAP, AND AN
 * EARLIER VERSION OF THIS COMMENT CLAIMED IT DID. `provisionMeeting`
 * (`services/meetings/provision-meeting.ts`) short-circuits with ZERO VENDOR CALLS the moment
 * a meeting's venue is already stamped (`dailyRoomName`/`joinUrl` both non-null) — true of
 * every meeting booked before this shipped. So `createOrFindRoom`, and therefore
 * `reconcileRoomRecording`, is NEVER REACHED for that population; the already-exists fallback
 * below only runs when `provisionMeeting` is called for a meeting NOT yet stamped and the room
 * name is already taken at Daily — a concurrent duplicate provision, or BAL-400's repair path
 * re-provisioning a meeting whose earlier venue write failed. What actually covers the
 * pre-deploy population is `enable_recording` set at the DAILY DOMAIN LEVEL (Daily supports an
 * always-on default at that scope) — the right home for an always-on platform guarantee (D5),
 * since a per-room property is inherently a per-room preference, never a platform one.
 * `reconcileRoomRecording` still earns its keep on the paths it DOES reach; it stays.
 */
import { z } from 'zod';
import { createLogger } from '@balo/shared/logging';
import { dailyRequest } from './client.js';
import { DailyApiError } from './errors.js';

const log = createLogger('daily-rooms');

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
 * BAL-473 (D5) — the always-on cloud recording mode. `'cloud'`, never `'cloud-audio-only'` or
 * `'raw-tracks'` (see the module docblock's "WHY `enable_recording` EARNED ITS WAY IN").
 *
 * ⚠ FIX ROUND 1 (F14) — moved BELOW the imports, beside `REQUIRED_PRIVACY` (the other
 * "value this module enforces on every room" constant). It previously sat ABOVE every import
 * in the file, which is not where a module-level constant belongs.
 */
const DAILY_RECORDING_MODE = 'cloud';

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
 * BAL-473 (OD-3) — reconcile `enable_recording` onto a room that ALREADY EXISTS (the
 * already-exists fallback below). `createOrFindRoom`'s `GET` fallback only ADOPTS a
 * pre-existing room; it reconciles nothing.
 *
 * ⚠⚠ FIX ROUND 2 (R1) — THIS DOES NOT REACH EVERY ROOM PROVISIONED BEFORE BAL-473 SHIPPED, AND
 * SAYING SO HERE WOULD BE A LIE. `provisionMeeting`'s replay guard
 * (`services/meetings/provision-meeting.ts`) short-circuits with zero vendor calls whenever a
 * meeting's venue is already stamped — true of every meeting booked before this shipped — so
 * `createOrFindRoom` is never called for that meeting and this function never runs for it. It
 * only runs when `provisionMeeting` is called for a meeting whose venue is NOT yet stamped and
 * the room name is already taken at Daily: a concurrent duplicate provision, or BAL-400's
 * repair path re-provisioning a meeting whose earlier venue write failed. Domain-level
 * `enable_recording` (set once, at the Daily domain, outside this codebase) is what actually
 * covers the pre-deploy population — a platform-wide always-on default is what D5 asks for,
 * and a per-room property can only ever be a per-room preference.
 *
 * `POST /rooms/:name` OVERRIDES an existing room's config without recreating it — the
 * daily-co skill's "Update room config" scenario.
 *
 * ⚠ RETURNS `null` ON **ANY** PROBLEM — a throw, or a 2xx body missing `name`/`url`/`privacy`
 * — RATHER THAN THROWING. Provisioning sits on the booking critical path and must not gain a
 * new failure mode from a knob this call is trying to fix up. A failed reconcile is a
 * `log.warn`; the caller falls through to the existing `GET` adoption, and the room simply
 * refuses to record — `recording-ensure`'s `startRoomRecording` call then fails with a
 * legible Daily 400 that lands in `meeting_recordings.failure_reason`. The failure is
 * VISIBLE; it just is not FATAL.
 */
async function reconcileRoomRecording(name: string): Promise<DailyRoomResponse | null> {
  try {
    const room = await dailyRequest<DailyRoomResponse>(
      'POST',
      `/rooms/${encodeURIComponent(name)}`,
      { properties: { enable_recording: DAILY_RECORDING_MODE } }
    );
    if (room.name === undefined || room.url === undefined || room.privacy === undefined) {
      log.warn(
        { roomName: name },
        'Daily room-recording reconcile returned a body missing name/url/privacy; falling back to GET adoption'
      );
      return null;
    }
    return room;
  } catch (error) {
    log.warn(
      {
        roomName: name,
        error: error instanceof Error ? error.message : String(error),
      },
      'Daily room-recording reconcile failed; falling back to GET adoption — the room will not record until this is retried'
    );
    return null;
  }
}

/**
 * POST the room, falling back to a `GET` (with a recording RECONCILE in between) when the
 * name is already taken.
 *
 * ⚠ THE ALREADY-EXISTS FALLBACK IS THE ONLY BRANCH, and it is what makes re-provisioning
 * safe. Daily answers `400` when a room name is taken; we then attempt to reconcile
 * `enable_recording` onto it (BAL-473, OD-3) and, failing that, `GET` the name — a `200` on
 * either is DIRECT PROOF the room is ours (the name is a pure function of `meetings.id`, so
 * no other meeting could have taken it). If BOTH the reconcile and the `GET` fail, the
 * original `400` was something else and must propagate unchanged.
 *
 * Branching on STATUS PLUS A SUCCESSFUL RESPONSE rather than on the vendor's error string is
 * deliberate: the string is not a stable contract.
 */
async function createOrFindRoom(name: string): Promise<VendorRoom> {
  try {
    const room = await dailyRequest<DailyRoomResponse>('POST', '/rooms', {
      name,
      privacy: REQUIRED_PRIVACY,
      properties: { enable_recording: DAILY_RECORDING_MODE },
    });
    return { room, method: 'POST', path: '/rooms' };
  } catch (error) {
    if (!(error instanceof DailyApiError) || error.status !== 400) {
      throw error;
    }
    // The name is taken. If it is taken by US (it can only be), reconcile recording onto it
    // (BAL-473) and, failing that, the GET adoption returns the room.
    const reconciled = await reconcileRoomRecording(name);
    if (reconciled !== null) {
      return { room: reconciled, method: 'POST', path: `/rooms/${encodeURIComponent(name)}` };
    }
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

// ── BAL-134 — TEARDOWN AND RECONCILIATION ─────────────────────────────────────────────────

/** What {@link deleteRoom} answers. Both values are SUCCESS; neither is an error. */
export type RoomTeardownOutcome = 'deleted' | 'already_gone';

/**
 * DELETE the meeting's Daily room, making a settled meeting genuinely unrejoinable.
 *
 * ⚠⚠ WHY THIS IS IN BAL-134 AT ALL, given the ticket is about timing. A Daily meeting token
 * SURVIVES AN EJECT — `eject_at_token_exp` is false and `exp` is `scheduled_end + 24h` — so
 * the shipped client-side `updateParticipants({'*': {eject: true}})` revokes nothing, and a
 * participant who kept their token could walk straight back into a settled room. Balo-side
 * rejoin refusal already exists (`MEETING_CLOSED_TO_JOIN` contains `ended`); deleting the room
 * is what closes the VENDOR side. Per-participant `ban: true` and the roster remove-from-call
 * path stay with BAL-444 — this adds `DELETE /rooms/:name` and nothing else.
 *
 * ⚠ A `404` IS `'already_gone'`, NOT AN ERROR. Daily auto-deletes an expiring room once the
 * last participant leaves, so racing that is the NORMAL outcome, not a failure — and the
 * caller's goal ("the room is not there any more") is satisfied either way. Treating it as an
 * error would make the end route log an error on its most common successful path.
 *
 * ⚠ EVERY OTHER NON-2xx THROWS, INCLUDING `429` — and there is deliberately NO RETRY LOOP
 * inside `dailyRequest` (`client.ts` rules that out explicitly). The end route logs and returns
 * `200` regardless (the meeting is already terminal in Postgres); the sweep's per-row try/catch
 * simply picks it up on the next tick. Room delete sits in the skill's 20/s tier, so a rate
 * limit here means something else is wrong.
 */
export async function deleteRoom(name: string): Promise<RoomTeardownOutcome> {
  try {
    await dailyRequest<unknown>('DELETE', `/rooms/${encodeURIComponent(name)}`);
    return 'deleted';
  } catch (error) {
    if (error instanceof DailyApiError && error.status === 404) {
      return 'already_gone';
    }
    throw error;
  }
}

/**
 * One participant as Daily's presence endpoint describes them.
 *
 * ⚠ EVERY FIELD IS OPTIONAL FOR THE SAME REASON `DailyRoomResponse`'s are: `dailyRequest` ends
 * in a bare `as T`, so this is an ASSERTION about a vendor payload rather than a guarantee
 * derived from one. The reconciler narrows `userId` before using it and treats an absent one as
 * "a participant we cannot map", which is the same fail-closed answer the presence writer gives
 * an unparseable participant id.
 */
export interface DailyPresenceParticipant {
  /** The `user_id` CLAIM we minted — `u`/`g` + 32 hex. ⚠ Never a bare uuid. */
  userId?: string;
  /** Daily's own session id for this participant. Correlation only; never an identity. */
  id?: string;
  joinTime?: string;
}

/**
 * Daily's `GET /presence` body: active participants grouped by room name.
 *
 * ⚠⚠ PARSED, NOT CAST — the ONE place in this file a vendor body is validated, and it is here
 * because this payload drives a DESTRUCTIVE decision. `dailyRequest` ends in a bare `as T`, so
 * a body of an unexpected SHAPE would type-check as an empty map and reach the sweep as
 * "confirmed: nobody is in any room", which closes every open interval on the platform and, ~5
 * minutes later, deletes live Daily rooms. A `safeParse` failure THROWS instead, so an
 * unrecognised body takes the same outage path as an unreachable vendor: reconciliation is
 * skipped, the terminal rules still run, and nothing is truncated.
 *
 * ⚠ THE SHAPE IS THE VERIFIED ONE AND MUST NOT BE "FIXED". The GLOBAL `GET /presence` really
 * is a MAP KEYED BY ROOM NAME (not the per-room endpoint's `{ total_count, data }` envelope),
 * and the participant field really is camelCase `userId` (not `user_id`). Both were checked
 * against Daily's live reference. Unknown keys are stripped by Zod's default, which is right:
 * nothing downstream may read a field this schema has not named.
 */
const dailyPresenceResponseSchema = z.record(
  z.string(),
  z.array(
    z.object({
      userId: z.string().optional(),
      id: z.string().optional(),
      joinTime: z.string().optional(),
    })
  )
);

/**
 * ACTIVE PARTICIPANTS ACROSS EVERY ROOM, in ONE call — leg 2 of D1's presence model, and the
 * reason the dropped-`participant.left` over-bill is bounded by one sweep tick rather than
 * being unbounded.
 *
 * ⚠ PLATFORM-WIDE, NOT PER-ROOM, AND THAT IS DELIBERATE. The skill names `GET /presence` as
 * Daily's recommended "current state" endpoint, and a per-room call per candidate meeting would
 * multiply a 20/s rate-limit tier by the size of the sweep batch. The sweep filters the answer
 * down to the rooms it is reconciling.
 *
 * ⚠ NEVER TRUSTED AS AN IDENTITY ORACLE. What comes back is a vendor's claim about who is in a
 * room; the reconciler uses it ONLY to decide whether an interval Balo already opened should be
 * CLOSED, and to open one for a participant whose `joined` webhook was dropped — and in the
 * latter case the `party` is still derived server-side from Balo's own tables, never from
 * anything in this payload.
 */
export async function getAllPresence(): Promise<Record<string, DailyPresenceParticipant[]>> {
  const body = await dailyRequest<unknown>('GET', '/presence');
  const parsed = dailyPresenceResponseSchema.safeParse(body ?? {});
  if (!parsed.success) {
    // ⚠ THROW, DO NOT DEGRADE. The caller's outage path treats a rejection as UNKNOWN; an
    // empty-looking return would be treated as CONFIRMED EMPTY. See the schema's docblock.
    throw new DailyApiError(
      'GET',
      '/presence',
      RESPONSE_CONTRACT_VIOLATION_STATUS,
      'Daily GET /presence returned a body this platform cannot interpret; refusing to read it as an empty platform'
    );
  }

  const rooms: Record<string, DailyPresenceParticipant[]> = {};
  for (const [roomName, participants] of Object.entries(parsed.data)) {
    if (participants !== undefined) {
      rooms[roomName] = participants;
    }
  }
  return rooms;
}

/**
 * The teardown seam, mirroring {@link RoomProvisioner}.
 *
 * ⚠ THE PORT EXISTS SO THE END SERVICE'S TESTS RUN WITH NO NETWORK AND NO DAILY ACCOUNT — the
 * same reason `RoomProvisioner` exists. Do not remove it as "indirection".
 */
export interface RoomTeardown {
  deleteRoom(name: string): Promise<RoomTeardownOutcome>;
}

/** The reconciliation seam, for the same reason. */
export interface PresenceReader {
  getAllPresence(): Promise<Record<string, DailyPresenceParticipant[]>>;
}

/** The live implementations. Tests substitute their own object literals. */
export const dailyRoomTeardown: RoomTeardown = { deleteRoom };
export const dailyPresenceReader: PresenceReader = { getAllPresence };
