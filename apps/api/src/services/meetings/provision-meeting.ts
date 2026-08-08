/**
 * BAL-129 (ADR-1044 / ADR-1045) — THE PROVISIONING SEAM: turn a confirmed booking into a
 * provisioned meeting. One `meetings` row, one `meeting_contexts` row, one `consultations`
 * projection row, and one PRIVATE Daily room whose name is derived bijectively from
 * `meetings.id`.
 *
 * ── THE ORDER IS FORCED, NOT CHOSEN ──────────────────────────────────────────
 *
 *   bookMeeting(...)                    // repo tx: meetings + contexts + projection,
 *                                       // then enqueue the availability-cache rebuild
 *      ↓  COMMITTED — the expert's calendar is already blocked
 *   dailyRoomNameForMeeting(meeting.id)
 *      ↓
 *   provisioner.createRoom(name)        // vendor
 *      ↓
 *   meetingsRepository.setVenue(...)    // stamp the venue
 *
 * `CreateMeetingInput` accepts `dailyRoomName`/`joinUrl` inline AND `setVenue` exists — but
 * the inline route is UNUSABLE here: the room name is keyed on `meetings.id`, which does not
 * exist until the insert returns, and `create` does not accept a caller-supplied id. Rejected
 * alternative: pre-mint a uuid and create the room first. That would widen the single write
 * path to accept an id, and it would create a vendor room BEFORE the booking that names it —
 * the only way to produce a genuinely orphaned room.
 *
 * It goes through `bookMeeting` and NEVER `meetingsRepository.create` directly, because the
 * post-commit availability-cache rebuild lives only in `apps/api`'s BullMQ layer; skipping it
 * leaves every expert-facing surface advertising a slot that is already taken.
 *
 * ── A PROVISIONING FAILURE COMMITS THE BOOKING (§3.2) ────────────────────────
 *
 * The booking is NOT rolled back and the route returns `201` with `provisioned: false`.
 *
 *   · The meeting, its context row and the projection are ALREADY COMMITTED in the
 *     repository's transaction, and the rebuild is already enqueued. There is no
 *     transactional boundary left to roll back across.
 *   · "Compensating" with `softDeleteMeeting` would be a WRITE ON AN ERROR PATH: it frees
 *     the slot, re-enqueues a second rebuild, and if IT fails you have a booking that blocks
 *     a calendar with no row anyone will look at again. Half-applied compensations are how
 *     you get the state nobody can reason about.
 *   · A `502` would tell the client "this failed" about a booking that exists and blocks an
 *     expert — the worst of the three outcomes, because the user rebooks and now two slots
 *     are blocked.
 *
 * CONSEQUENCE FOR THE CLIENT, stated so BAL-400 designs for it: the meeting exists, the slot
 * is blocked, the calendar is correct, and there is NO JOIN URL YET. A `provisioned: false`
 * response is a SUCCESS WITH A MISSING ARTEFACT, not a failure.
 *
 * ── IDEMPOTENCY (D2), AND ITS ONE ARBITER ────────────────────────────────────
 *
 * `provisionMeeting` short-circuits on an already-stamped meeting. The arbiter for two
 * concurrent calls is THE DETERMINISTIC ROOM NAME AND NOTHING ELSE: both racers derive the
 * same name, so the loser's create is a `400 already-exists` that resolves to THE SAME room,
 * and both `setVenue` writes are byte-identical `UPDATE`s on ONE row (they serialize on the
 * row lock; last-writer-wins is indistinguishable from first-writer-wins). **THE CONCURRENT
 * RACE THEREFORE STRANDS NO ROOM** — the loser does not create a second one, it finds the
 * first — which is why there is no `deleteRoom` call on the race path.
 *
 * ⚠⚠ THAT IS THE WHOLE SCOPE OF THE CLAIM. IT IS **NOT** "NO ORPHAN ROOM CAN EXIST", and an
 * earlier version of this block said so — which mattered, because that sentence was the stated
 * reason for shipping no cleanup at all. TWO LIVE PATHS DO STRAND A ROOM AT THE VENDOR, and
 * BAL-129 ACCEPTS BOTH rather than fixing them here:
 *
 *   (i) `createRoom` SUCCEEDS AND `setVenue` THROWS. The room exists under this meeting's
 *       derived name with nothing in the database pointing at it, and NO REPAIR PATH SHIPS in
 *       this PR — nothing calls `provisionMeeting` again, so nothing ever claims it. Owner:
 *       **BAL-400** (which owns the booking UX and is the only surface that will know a
 *       meeting is unprovisioned). Cheap to fix precisely because the name is re-derivable.
 *  (ii) `cancelMeeting` / `softDeleteMeeting` DELETE NO DAILY ROOM. A cancelled booking leaves
 *       its room behind for good. Owner: **BAL-410** (cancel). (Moot in this PR: neither has a
 *       production caller yet — see the note on irreversibility in
 *       `services/meetings/authorize-meeting-booking.ts`.)
 * (iii) `createRoom` REFUSES ITS OWN CREATION. The vendor-response checks in
 *       `services/daily/rooms.ts` — privacy, then the `name`/`url` fields — run AFTER the POST
 *       has already created the room, so a room the platform then refuses is stranded by the
 *       refusal itself.
 *
 * Rooms are created with NO `exp` (D9 — every Daily knob except `privacy` is left at the
 * vendor default), so a stranded room persists at the vendor indefinitely.
 *
 * ⚠ AND THE EXPOSURE ARGUMENT MUST BE STATED IN THE RIGHT DIRECTION, because the obvious
 * version is BACKWARDS for the one case it most needs to cover. "The room is private, so it
 * admits nobody without a token" holds for (i) and (ii) — those rooms passed the privacy check.
 * It does NOT hold for the privacy arm of (iii): that room is stranded PRECISELY BECAUSE it
 * came back PUBLIC. Worse, it is permanently un-adoptable — every re-provision derives the same
 * name, the POST returns `400 already-exists`, the GET returns the same public room, and the
 * check throws again — so no code path can ever fix or reuse it.
 *
 * The harm is nevertheless low, and this is the honest reason: `setVenue` never ran, so that
 * URL was never stored, never returned in a response and never shown to anyone. What is
 * stranded is an EMPTY, UNADVERTISED room whose address is only computable by someone who
 * already holds the `meetings.id`. Accepted and recorded, not dismissed — deleting it is
 * BAL-400's repair path, alongside (i).
 *
 * ⚠ THIS TICKET WRITES NO `onConflict` CLAUSE ANYWHERE, and that is worth recording: `create`
 * is a bare INSERT, `setVenue` is a bare UPDATE, and the arbiter is the name, not an index.
 * The recorded hazard — an `ON CONFLICT` arbiter targeting the PARTIAL
 * `meeting_daily_room_name_idx` must inline literals via raw `sql`, because a Drizzle `eq()`
 * Param fails `42P10` — is therefore STRUCTURALLY UNREACHABLE in this diff. Anyone reaching
 * for `onConflictDoNothing` here is re-opening it.
 *
 * ⚠ AND `setVenue` STAYS EXACTLY AS SHIPPED — do NOT add `WHERE daily_room_name IS NULL`. It
 * would buy nothing (the loser writes the same bytes) and it would BREAK THE REPAIR PATH: a
 * meeting stamped with a room later deleted at the vendor could never be re-stamped, because
 * the conditional would match zero rows and the update would throw "Meeting not found" — an
 * error whose message would be a lie.
 *
 * ⚠ WHAT THIS DOES **NOT** DELIVER: booking-level double-submit dedup (D2). `POST /meetings`
 * takes no meeting id and no idempotency key, `meetings.id` is `defaultRandom()`, and there
 * is no idempotency-key column — so TWO IDENTICAL POSTS CREATE TWO MEETINGS AND TWO ROOMS.
 * That is D2's explicit narrowing, not a defect of this design; closing it needs a schema
 * change. **BAL-400** owns it. The idempotent entry point is `provisionMeeting(meetingId, …)`.
 *
 * ⚠ `provisionMeeting` IS EXPORTED SEPARATELY FROM `bookAndProvisionMeeting` PRECISELY SO
 * BAL-400'S REPAIR PATH HAS SOMETHING TO CALL. Nothing calls it automatically today: there is
 * no sweep, no retry job and no repair endpoint in this PR. A sweep would mean a new jobs
 * module, which means a `startWorkers()` registration, which means `worker.test.ts` must mock
 * it or CI hangs on real Redis — real cost for a path that has no producer yet (D6).
 *
 * ⚠ THIS MODULE RESOLVES NO AUTHORIZATION **AND VALIDATES NO AVAILABILITY**, and both are the
 * caller's obligation. Before a `contextId` reaches here the caller must have run
 * `authorizeMeetingBooking` (tenancy — see that module and `schema/meeting-contexts.ts`) AND
 * `isWindowAvailableForExpert` (`services/availability/window-availability.ts` — the aggregate
 * availability-DoS bound). `POST /meetings` does both, in that order.
 *   Neither check lives HERE on purpose: this module is also the entry point for BAL-400's
 *   repair path, which re-provisions a meeting that was ALREADY authorized and whose window is
 *   already booked — re-running an availability check there would refuse to heal exactly the
 *   bookings that need healing, because the meeting's own consultation row now reads as busy.
 */
import { meetingsRepository, type CreatedMeeting, type Meeting } from '@balo/db';
import { MEETING_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import { dailyRoomNameForMeeting, type MeetingBookingContextType } from '@balo/shared/meetings';
import type { FastifyBaseLogger } from 'fastify';
import { DailyApiError } from '../daily/errors.js';
import type { RoomProvisioner } from '../daily/rooms.js';
import { dailyRoomProvisioner } from '../daily/rooms.js';
import type { BookableEngagementType } from './authorize-meeting-booking.js';
import { bookMeeting } from './meeting-availability.js';

/** The venue half of the outcome — both fields, or neither (§3.2). */
export interface MeetingVenue {
  provisioned: boolean;
  dailyRoomName: string | null;
  joinUrl: string | null;
}

export interface ProvisionMeetingResult extends MeetingVenue {
  meetingId: string;
  /** `true` when the meeting was ALREADY stamped: no Daily call, no write (D2). */
  replayed: boolean;
}

/** What the analytics events need that cannot be read off the meeting row. */
export interface MeetingProvisionContext {
  contextType: MeetingBookingContextType;
  engagementType: BookableEngagementType | null;
  /** The booking actor — PostHog's `distinct_id`. */
  userId: string;
}

export interface ProvisionMeetingDeps {
  provisioner?: RoomProvisioner;
}

export interface BookAndProvisionInput {
  contextType: MeetingBookingContextType;
  contextId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  engagementType: BookableEngagementType | null;
  userId: string;
}

export interface BookAndProvisionResult extends MeetingVenue {
  meeting: Meeting;
}

const MS_PER_MINUTE = 60_000;

/** Whole minutes between two instants, floored — never negative for a valid window. */
function minutesBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_MINUTE);
}

/**
 * Emit `meeting_provisioned`. Lives HERE rather than in the route so a future second caller
 * (BAL-400's repair path) emits without duplicating the call. `trackServer` is a no-op
 * without `POSTHOG_API_KEY`, so dev and CI are unaffected.
 */
function trackProvisioned(
  meeting: Meeting,
  context: MeetingProvisionContext,
  now: Date,
  replayed: boolean
): void {
  trackServer(MEETING_SERVER_EVENTS.MEETING_PROVISIONED, {
    meeting_id: meeting.id,
    context_type: context.contextType,
    engagement_type: context.engagementType,
    duration_minutes: minutesBetween(meeting.scheduledStart, meeting.scheduledEnd),
    lead_time_minutes: minutesBetween(now, meeting.scheduledStart),
    idempotent_replay: replayed,
    distinct_id: context.userId,
  });
}

/**
 * PROVISION (or re-provision) one meeting's Daily room, idempotently.
 *
 * Reads first: a meeting whose venue is ALREADY stamped short-circuits with `replayed: true`
 * — zero vendor calls, zero writes. The guard requires BOTH columns to be non-null, and
 * treating one as unprovisioned is the fail-safe reading (re-provisioning is harmless).
 *
 * ⚠ "A HALF-STAMPED ROW IS NOT PRODUCIBLE" IS TRUE ONLY BECAUSE `createRoom` VALIDATES THE
 * VENDOR RESPONSE — do not restate it as a property of `setVenue`, which is where an earlier
 * version of this line went wrong. `setVenue` writes both columns from one object, but
 * `updateLiveMeeting` patches with `{ ...set, updatedAt }` and DRIZZLE OMITS UNDEFINED KEYS, so
 * an object carrying `joinUrl: undefined` would stamp `daily_room_name` alone and leave
 * `join_url` NULL — and this very guard would then read that meeting as unprovisioned FOREVER,
 * with each repair re-stamping the same one column. `client.ts`'s `dailyRequest` ends in a bare
 * `as T`, so a 2xx body missing `url` reaches here as exactly that object. What closes it is
 * `services/daily/rooms.ts`'s `requireField`, which refuses a response missing either field
 * (both paths, POST and GET-fallback) and turns the case into an ordinary `provisioned: false`.
 *
 * Returns `provisioned: false` rather than throwing when the vendor fails — see the module
 * docblock, and `provisionVenue` for exactly what the `try` covers (it is deliberately wider
 * than "only the Daily call").
 */
export async function provisionMeeting(
  meetingId: string,
  context: MeetingProvisionContext,
  log: FastifyBaseLogger,
  deps: ProvisionMeetingDeps = {}
): Promise<ProvisionMeetingResult | undefined> {
  const existing = await meetingsRepository.findById(meetingId);
  if (existing === undefined) {
    return undefined;
  }

  const { dailyRoomName, joinUrl } = existing;
  if (dailyRoomName !== null && joinUrl !== null) {
    trackProvisioned(existing, context, new Date(), true);
    return { meetingId, provisioned: true, dailyRoomName, joinUrl, replayed: true };
  }

  const venue = await provisionVenue(existing, context, log, deps);
  return { meetingId, ...venue, replayed: false };
}

/**
 * The vendor call plus the venue stamp, for a meeting known to be live and unstamped.
 * Shared by `provisionMeeting` and `bookAndProvisionMeeting` so the failure handling, the
 * logging shape and the analytics emission are defined EXACTLY ONCE.
 *
 * ⚠⚠ THE `try` COVERS `setVenue` **AS WELL AS** THE DAILY CALL, DELIBERATELY. DO NOT "TIGHTEN"
 * IT TO WRAP ONLY `createRoom`. By the time this function runs the booking has ALREADY
 * COMMITTED — the meeting, its context row and the `consultations` projection are durable and
 * the availability rebuild is enqueued. A transient database blip on the venue UPDATE is
 * therefore exactly as recoverable as a vendor outage: both leave a real booking with a null
 * venue, both are healed by re-running `provisionMeeting(M)` (which re-derives the same room
 * name and adopts the existing room via the already-exists branch), and both must answer `201
 * provisioned: false`. Narrowing the `try` would turn that transient into a `500` on a booking
 * that HAPPENED — telling the client "this failed" about a slot that is blocked, so they
 * rebook and block a second one. That is the outcome §3.2 rejects by name.
 *
 * ⚠ WHAT IS **NOT** IN THE `try`, AND MUST NOT BE: `bookMeeting`. Its typed errors are the
 * route's branchable reasons — see `bookAndProvisionMeeting`.
 */
async function provisionVenue(
  meeting: Meeting,
  context: MeetingProvisionContext,
  log: FastifyBaseLogger,
  deps: ProvisionMeetingDeps
): Promise<MeetingVenue> {
  const provisioner = deps.provisioner ?? dailyRoomProvisioner;
  const roomName = dailyRoomNameForMeeting(meeting.id);

  try {
    const room = await provisioner.createRoom(roomName);
    await meetingsRepository.setVenue(meeting.id, room);
    trackProvisioned(meeting, context, new Date(), false);
    return { provisioned: true, dailyRoomName: room.dailyRoomName, joinUrl: room.joinUrl };
  } catch (error) {
    // ⚠ THE `meetingId` IS WHAT MAKES THE REPAIR ACTIONABLE — without it the log names a
    // failure nobody can act on. The booking itself STANDS; see the module docblock.
    //
    // ⚠ AND `vendorBody` IS WHY `DailyApiError` CARRIES ONE. Its docblock says the raw
    // response text is "FOR THE SERVER LOG ONLY" — this is that log, and it is the only place
    // the body is ever read. `error.message` is `Daily API error: POST /rooms responded 503`
    // and deliberately EXCLUDES the body, so without this field the vendor's own explanation
    // ("room name already taken", "invalid domain", a quota message) was captured NOWHERE and
    // the repair path had a status and nothing else to go on.
    //   · It stays OUT of the analytics `reason`, which correctly carries the error CLASS.
    //   · It stays OUT of every response body (§6.3's no-echo rule).
    log.error(
      {
        meetingId: meeting.id,
        contextType: context.contextType,
        errorName: error instanceof Error ? error.name : 'unknown',
        error: error instanceof Error ? error.message : String(error),
        vendorBody: error instanceof DailyApiError ? error.body : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Meeting booked but Daily room provisioning failed'
    );
    trackServer(MEETING_SERVER_EVENTS.MEETING_PROVISION_FAILED, {
      meeting_id: meeting.id,
      context_type: context.contextType,
      engagement_type: context.engagementType,
      // The error CLASS, never the message — the message can carry vendor detail.
      reason: error instanceof Error ? error.name : 'unknown',
      distinct_id: context.userId,
    });
    return { provisioned: false, dailyRoomName: null, joinUrl: null };
  }
}

/**
 * BOOK then PROVISION — the route's entry point.
 *
 * The booking half is deliberately NOT wrapped in a `try`: `bookMeeting`'s typed errors
 * (`MeetingExpertAmbiguousError`, `MatchModeDiscoveryNotBookableError`,
 * `MeetingContextUnresolvableError`, `MeetingContextNotProjectableError`,
 * `MeetingContextRequiredError`) MUST reach the route intact so it can map each to its own
 * status code. Catching here would flatten branchable reasons into one 500 — the same rule
 * `meeting-availability.ts`'s docblock states for itself.
 */
export async function bookAndProvisionMeeting(
  input: BookAndProvisionInput,
  log: FastifyBaseLogger,
  deps: ProvisionMeetingDeps = {}
): Promise<BookAndProvisionResult> {
  const created: CreatedMeeting = await bookMeeting(
    {
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      contexts: [{ contextType: input.contextType, contextId: input.contextId }],
    },
    log
  );

  const venue = await provisionVenue(
    created.meeting,
    {
      contextType: input.contextType,
      engagementType: input.engagementType,
      userId: input.userId,
    },
    log,
    deps
  );

  return { meeting: created.meeting, ...venue };
}
