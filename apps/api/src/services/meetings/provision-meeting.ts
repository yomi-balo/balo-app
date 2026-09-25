/**
 * BAL-129 (ADR-1044 / ADR-1045) — THE PROVISIONING SEAM: turn a confirmed booking into a
 * provisioned meeting. One `meetings` row, one `meeting_contexts` row, one `consultations`
 * projection row, and one PRIVATE Daily room whose name is derived bijectively from
 * `meetings.id`.
 *
 * ── THE ORDER IS FORCED, NOT CHOSEN ──────────────────────────────────────────
 *
 *   bookMeeting(...)                    // repo tx: meetings + contexts + projection +
 *                                       // the `meeting.booked` audit row (ADR-1044 §5),
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
 * CONSEQUENCE FOR THE CLIENT: the meeting exists, the slot is blocked, the calendar is
 * correct, and there is NO JOIN URL YET. A `provisioned: false` response is a SUCCESS WITH A
 * MISSING ARTEFACT, not a failure — the venue repair job (`jobs/meeting-venue-repair.ts`,
 * BAL-581) is what closes the gap, on its own checkpoint schedule, no user action required.
 *
 * ── IDEMPOTENCY (D2), AND ITS ONE ARBITER ────────────────────────────────────
 *
 * `provisionMeeting` short-circuits on a meeting whose venue is READY per `isMeetingVenueReady`
 * (`@balo/shared/meetings` — both columns non-null AND the stamped name equals
 * `dailyRoomNameForMeeting(id)`, BAL-581). The arbiter for two concurrent calls is THE
 * DETERMINISTIC ROOM NAME AND NOTHING ELSE: both racers derive the same name, so the loser's
 * create is a `400 already-exists` that resolves to THE SAME room, and both `setVenue` writes
 * stamp identical `daily_room_name`/`join_url` columns (they serialize on the row lock; only
 * `venue_provisioned_at` can differ, by the race's gap, and last-write-wins there is harmless).
 * **THE CONCURRENT RACE THEREFORE STRANDS NO ROOM** — the loser does not create a second one,
 * it finds the first — which is why there is no `deleteRoom` call on the race path.
 *
 * ⚠⚠ THAT IS THE WHOLE SCOPE OF THE CLAIM. IT IS **NOT** "NO ORPHAN ROOM CAN EXIST", and an
 * earlier version of this block said so — which mattered, because that sentence was the stated
 * reason for shipping no cleanup at all. TWO LIVE PATHS DO STRAND A ROOM AT THE VENDOR, and
 * BAL-129 ACCEPTS BOTH rather than fixing them here:
 *
 *   (i) `createRoom` SUCCEEDS AND `setVenue` THROWS. The room exists under this meeting's
 *       derived name with nothing in the database pointing at it — but the venue repair job
 *       (`jobs/meeting-venue-repair.ts`, BAL-581) re-derives the same name and adopts the room
 *       on its next checkpoint, via `createOrFindRoom`'s already-exists path.
 *  (ii) `softDeleteMeeting` DELETES NO DAILY ROOM. ⚠ NARROWED BY BAL-410, which CLOSED the
 *       cancel half: `cancelMeeting` now deletes the room post-commit (guarded by the
 *       derived-name check, best-effort and non-fatal — `meeting-availability.ts`'s
 *       `tearDownRoomBestEffort`). `softDeleteMeeting` still strands a room and has no route
 *       and no owner; the residual is recorded here rather than pretended away. It is vendor
 *       hygiene only: `MEETING_CLOSED_TO_JOIN` refuses a Balo-side rejoin either way.
 * (iii) `createRoom` REFUSES ITS OWN CREATION. The vendor-response checks in
 *       `services/daily/rooms.ts` — privacy, then the `name`/`url` fields — run AFTER the POST
 *       has already created the room, so a room the platform then refuses is stranded by the
 *       refusal itself. The PRIVACY arm converges (BAL-581): `createRoom` throws
 *       `DailyRoomNotPrivateError` and `provisionVenue`'s catch best-effort deletes that public
 *       room, so the venue repair job's next checkpoint creates a private one instead of
 *       adopting the same refused room forever. The missing-FIELD arm has no such repair — a
 *       room missing `name`/`url` in its response is not a privacy hazard (see the exposure
 *       note below) and is simply left stranded, unadvertised.
 *
 * Rooms are created with NO `exp` (D9 — every Daily knob except `privacy` is left at the
 * vendor default), so a stranded room persists at the vendor indefinitely.
 *
 * ⚠ AND THE EXPOSURE ARGUMENT MUST BE STATED IN THE RIGHT DIRECTION, because the obvious
 * version is BACKWARDS for the one case it most needs to cover. "The room is private, so it
 * admits nobody without a token" holds for (i) and (ii) — those rooms passed the privacy check.
 * It does NOT hold for the privacy arm of (iii): that room is stranded PRECISELY BECAUSE it
 * came back PUBLIC — the adoption path is POST `400` (already-exists) → reconcile
 * `POST /rooms/:name` (BAL-473's recording knob) → GET, and every leg of it re-checks privacy
 * and re-throws on the same public room. BAL-581 closes it: `provisionVenue` deletes
 * that public room (`DailyRoomNotPrivateError`) so the next attempt creates a private one.
 *
 * The harm was nevertheless always low, and this is the honest reason: `setVenue` never ran,
 * so that URL was never stored, never returned in a response and never shown to anyone. What
 * is stranded (best-effort deletion aside) is an EMPTY, UNADVERTISED room whose address is
 * only computable by someone who already holds the `meetings.id`.
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
 * ⚠ BOOKING-LEVEL DOUBLE-SUBMIT DEDUP (D2) IS BAL-400'S, NOT THIS MODULE'S SHORT-CIRCUIT:
 * `POST /meetings` accepts an optional `bookingIdempotencyKey` (a `sha256(userId:nonce)`
 * digest), stored on `meetings.booking_idempotency_key` behind a partial unique index. A lost
 * `201` retries through `lookupBookingReplay` / `replayByIdempotencyKey`, below — NOT through
 * this short-circuit, which only ever sees a meeting id that already exists. A caller with no
 * key still creates two meetings and two rooms on two identical POSTs; that is unchanged.
 *
 * ⚠ `provisionMeeting` IS EXPORTED SEPARATELY FROM `bookAndProvisionMeeting` because it has
 * TWO OTHER CALLERS besides the fresh-booking path: the lost-201 REPLAY
 * (`replayByIdempotencyKey`, below) and the venue repair job
 * (`jobs/meeting-venue-repair.ts`, BAL-581) — a per-minute producer that re-provisions a
 * `scheduled` meeting whose venue never became ready, on a deterministic checkpoint schedule.
 *
 * ⚠ THIS MODULE RESOLVES NO AUTHORIZATION **AND VALIDATES NO AVAILABILITY**, and both are the
 * caller's obligation. Before a `contextId` reaches here the caller must have run
 * `authorizeMeetingBooking` (tenancy — see that module and `schema/meeting-contexts.ts`) AND
 * `isWindowAvailableForExpert` (`services/availability/window-availability.ts` — the aggregate
 * availability-DoS bound). `POST /meetings` does both, in that order.
 *   Neither check lives HERE on purpose: this module is also the entry point for the venue
 *   repair job, which re-provisions a meeting that was ALREADY authorized and whose window is
 *   already booked — re-running an availability check there would refuse to heal exactly the
 *   bookings that need healing, because the meeting's own consultation row now reads as busy.
 */
import * as Sentry from '@sentry/node';
import { meetingsRepository, type CreatedMeeting, type Meeting } from '@balo/db';
import { MEETING_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import {
  dailyRoomNameForMeeting,
  isMeetingVenueReady,
  type MeetingBookingContextType,
  type MeetingProvisionTrigger,
} from '@balo/shared/meetings';
import type { FastifyBaseLogger } from 'fastify';
import { DailyApiError, DailyRoomNotPrivateError } from '../daily/errors.js';
import type { RoomProvisioner, RoomTeardown } from '../daily/rooms.js';
import { dailyRoomProvisioner, dailyRoomTeardown } from '../daily/rooms.js';
import { publishBookingCalendarInvites } from '../calendar-invites/publish-calendar-invites.js';
import {
  projectBookingCalendarEvent,
  recordClientCalendarEntry,
  type ExpertCalendarDelivery,
} from '../consultation-events/booking-calendar-projection.js';
import type { BookableEngagementType } from './authorize-meeting-booking.js';
import { bookMeeting } from './meeting-availability.js';

/**
 * BAL-400 (Decision 7) — thrown when a `bookingIdempotencyKey` resolves to an already-live
 * meeting that is NOT the booking being submitted: either its live context of the submitted
 * `contextType` names a DIFFERENT `contextId`, or it is scheduled in a DIFFERENT WINDOW. The
 * key is `sha256(userId:nonce)`, so cross-user reuse is already unreachable; this closes the
 * remaining same-user holes — reusing a key against a different case, or against a different
 * time. Mapped to `409 idempotency_key_conflict` by the route; never `err.message`-echoed (it
 * embeds a raw meeting id).
 */
export class BookingIdempotencyKeyConflictError extends Error {
  constructor(meetingId: string) {
    super(`Booking idempotency key already resolves to a different booking (meeting ${meetingId})`);
    this.name = 'BookingIdempotencyKeyConflictError';
  }
}

/** A Postgres unique violation — the concurrent-double-submit race, mapped rather than 500'd. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

/** The venue half of the outcome — both fields, or neither (§3.2). */
export interface MeetingVenue {
  provisioned: boolean;
  dailyRoomName: string | null;
  joinUrl: string | null;
}

export interface ProvisionMeetingResult extends MeetingVenue {
  meetingId: string;
  /** `true` when the meeting was ALREADY venue-ready per `isMeetingVenueReady`: no Daily call, no write (D2). */
  replayed: boolean;
}

/** What the analytics events need that cannot be read off the meeting row. */
export interface MeetingProvisionContext {
  contextType: MeetingBookingContextType;
  engagementType: BookableEngagementType | null;
  /**
   * PostHog's `distinct_id`: the BOOKING ACTOR on `trigger: 'booking'` / `'replay'`; the
   * MEETING id on `trigger: 'repair'` (the venue repair job has no acting human — see
   * `jobs/meeting-venue-repair.ts`, the same non-user shape `meeting_ended`'s system paths
   * already use). Named `distinctId`, not `userId`, because it does not always hold one.
   */
  distinctId: string;
  /** What caused this attempt. Segments `lead_time_minutes` (a repair's lead
   * time measures salvage lateness, not booking lead time) and the Sentry volume rule below. */
  trigger: MeetingProvisionTrigger;
  /**
   * `true` ⇒ a failure is `log.error` + `Sentry.captureException`; `false` ⇒
   * `log.warn` only, no Sentry. Booking and replay always escalate (a live user is waiting).
   * The venue repair job escalates ONLY its FINAL checkpoint before the cutoff, so a whole
   * outage costs one Sentry event per meeting rather than one per attempt.
   */
  escalateFailure: boolean;
}

export interface ProvisionMeetingDeps {
  provisioner?: RoomProvisioner;
  /** Defaults to the live `dailyRoomTeardown`; tests substitute their own. */
  teardown?: RoomTeardown;
}

export interface BookAndProvisionInput {
  contextType: MeetingBookingContextType;
  contextId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  engagementType: BookableEngagementType | null;
  userId: string;
  /**
   * BAL-400 (Decision 7) — OPTIONAL. When present, `bookAndProvisionMeeting` checks for an
   * already-live meeting under this key BEFORE calling `bookMeeting`, and replays through
   * `provisionMeeting` instead of creating a second meeting/room/notification fan-out. See the
   * module docblock's "WHAT THIS DOES NOT DELIVER" section — this is what closes that gap.
   */
  bookingIdempotencyKey?: string;
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
 * Emit `meeting_provisioned`. Lives HERE rather than in the route so every caller — booking,
 * the lost-201 replay, and the venue repair job (`jobs/meeting-venue-repair.ts`) — emits
 * without duplicating the call. `trackServer` is a no-op without `POSTHOG_API_KEY`, so dev and
 * CI are unaffected.
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
    trigger: context.trigger,
    distinct_id: context.distinctId,
  });
}

/**
 * PROVISION (or re-provision) one meeting's Daily room, idempotently.
 *
 * Reads first: a meeting whose venue is ALREADY READY short-circuits with `replayed: true` —
 * zero vendor calls, zero writes. The guard is `isMeetingVenueReady` (`@balo/shared/meetings`)
 * — BOTH columns non-null AND the stamped name equals `dailyRoomNameForMeeting(id)` (BAL-581)
 * — so a MISMATCHED stamp (a corrupt or foreign name) falls through to a real provision
 * rather than being trusted, and `setVenue` re-stamps it with the correct name. Treating a
 * not-yet-ready meeting as unprovisioned is the fail-safe reading either way: re-provisioning
 * is harmless (the vendor call is idempotent by name).
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

  if (isMeetingVenueReady(existing)) {
    trackProvisioned(existing, context, new Date(), true);
    return {
      meetingId,
      provisioned: true,
      dailyRoomName: existing.dailyRoomName,
      joinUrl: existing.joinUrl,
      replayed: true,
    };
  }

  const venue = await provisionVenue(existing, context, log, deps);
  return { meetingId, ...venue, replayed: false };
}

/**
 * BAL-581 — best-effort delete of a room `createRoom` refused for coming back public.
 * Its OWN try/catch: a delete failure must never mask the ORIGINAL provisioning failure this
 * runs inside, and must never throw out of `provisionVenue`'s catch. The next repair
 * checkpoint retries the delete for free (it re-derives the same name).
 */
async function deleteStrandedRoomBestEffort(
  roomName: string,
  meetingId: string,
  deps: ProvisionMeetingDeps,
  log: FastifyBaseLogger
): Promise<void> {
  const teardown = deps.teardown ?? dailyRoomTeardown;
  try {
    await teardown.deleteRoom(roomName);
  } catch (error) {
    log.warn(
      {
        meetingId,
        roomName,
        error: error instanceof Error ? error.message : String(error),
      },
      'Stranded public Daily room could not be deleted — the next repair checkpoint retries'
    );
  }
}

/**
 * Log, escalate and emit analytics for a failed venue provision. Extracted from `provisionVenue`
 * purely to keep that function under SonarCloud's cognitive-complexity limit — every line here
 * was inline there before.
 *
 * ⚠ THE `meetingId` IS WHAT MAKES THE REPAIR ACTIONABLE — without it the log names a
 * failure nobody can act on. The booking itself STANDS; see the module docblock.
 *
 * ⚠ AND `vendorBody` IS WHY `DailyApiError` CARRIES ONE. Its docblock says the raw
 * response text is "FOR THE SERVER LOG ONLY" — this is that log, and it is the only place
 * the body is ever read. `error.message` is `Daily API error: POST /rooms responded 503`
 * and deliberately EXCLUDES the body, so without this field the vendor's own explanation
 * ("room name already taken", "invalid domain", a quota message) was captured NOWHERE and
 * the repair path had a status and nothing else to go on.
 *   · It stays OUT of the analytics `reason`, which correctly carries the error CLASS.
 *   · It stays OUT of every response body (the no-echo rule for vendor error text).
 *   · It stays OUT of Sentry's `extra` — see the `escalateFailure` branch below.
 *
 * BAL-581 — booking and replay always escalate (a live user is waiting on this meeting); the
 * venue repair job escalates ONLY its final checkpoint before the cutoff, so a whole outage
 * costs one Sentry event per meeting rather than one per attempt.
 */
function reportProvisionFailure(
  meeting: Meeting,
  context: MeetingProvisionContext,
  error: unknown,
  log: FastifyBaseLogger
): void {
  const errorName = error instanceof Error ? error.name : 'unknown';
  const fields = {
    meetingId: meeting.id,
    contextType: context.contextType,
    trigger: context.trigger,
    errorName,
    error: error instanceof Error ? error.message : String(error),
    vendorBody: error instanceof DailyApiError ? error.body : undefined,
    stack: error instanceof Error ? error.stack : undefined,
  };
  const message = 'Meeting booked but Daily room provisioning failed';

  if (context.escalateFailure) {
    log.error(fields, message);
    // `extra` carries NO `vendorBody` — the raw vendor response text never reaches Sentry,
    // only the error's own `message` (which itself excludes the body, see above).
    Sentry.captureException(error, {
      extra: {
        meetingId: meeting.id,
        contextType: context.contextType,
        trigger: context.trigger,
      },
    });
  } else {
    log.warn(fields, message);
  }

  trackServer(MEETING_SERVER_EVENTS.MEETING_PROVISION_FAILED, {
    meeting_id: meeting.id,
    context_type: context.contextType,
    engagement_type: context.engagementType,
    // The error CLASS, never the message — the message can carry vendor detail.
    reason: errorName,
    trigger: context.trigger,
    distinct_id: context.distinctId,
  });
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
    // A public room is the one PER-MEETING permanent failure with a known remedy: delete it so
    // the NEXT attempt creates a private one. Runs before the report below so the delete happens
    // regardless of the `escalateFailure` branch.
    if (error instanceof DailyRoomNotPrivateError) {
      await deleteStrandedRoomBestEffort(roomName, meeting.id, deps, log);
    }

    reportProvisionFailure(meeting, context, error, log);
    return { provisioned: false, dailyRoomName: null, joinUrl: null };
  }
}

/**
 * BAL-400 (Decision 7) — what identifies "the SAME booking" for an idempotent replay. Both
 * halves are load-bearing: the CONTEXT (which case) and the WINDOW (which time).
 */
export interface BookingReplayProbe {
  contextType: MeetingBookingContextType;
  contextId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}

/** The three outcomes of resolving a `bookingIdempotencyKey` against a submitted booking. */
export type BookingReplayLookup =
  /** No meeting exists under this key yet — the caller must create one. */
  | { readonly kind: 'none' }
  /** The key names THIS booking: same context, same window. Replay it. */
  | { readonly kind: 'match'; readonly meeting: Meeting }
  /** The key names a DIFFERENT booking (other case, or other window). Refuse. */
  | { readonly kind: 'conflict'; readonly meetingId: string };

/**
 * BAL-400 (S3/M1) — THE ONE DEFINITION OF "this key names this booking". Exported because
 * `POST /meetings` must consult it BEFORE its availability gate, and `replayByIdempotencyKey`
 * consults it again inside the service. A second, drifting copy of this predicate is exactly
 * how a replay starts resolving to a meeting the client never asked for.
 *
 * ⚠⚠ THE WINDOW COMPARISON IS NOT OPTIONAL, and the semantics chosen here are deliberate:
 * **a key that resolves to a DIFFERENT window is a CONFLICT (409), never a silent replay.**
 * The alternative — return the existing meeting for whatever window the client last submitted
 * — was rejected: the client's own wrapper freezes the nonce after a failed meeting hop, so a
 * user who then picks a different time would be silently booked at the ORIGINAL time. Telling
 * them "that key is already spent on another booking" is the only answer that cannot lie. The
 * `scheduledStart`/`scheduledEnd` now returned to the caller (S2) mean an honest replay also
 * reports the real window rather than echoing the request back.
 *
 * ⚠ ORDER: the window is compared first because it costs no second read. `findWithContexts`
 * only runs once the window already agrees.
 */
export async function lookupBookingReplay(
  key: string,
  probe: BookingReplayProbe
): Promise<BookingReplayLookup> {
  const existing = await meetingsRepository.findByBookingIdempotencyKey(key);
  if (existing === undefined) {
    return { kind: 'none' };
  }

  if (
    existing.scheduledStart.getTime() !== probe.scheduledStart.getTime() ||
    existing.scheduledEnd.getTime() !== probe.scheduledEnd.getTime()
  ) {
    return { kind: 'conflict', meetingId: existing.id };
  }

  const withContexts = await meetingsRepository.findWithContexts(existing.id);
  const matchesContext =
    withContexts !== undefined &&
    withContexts.contexts.some(
      (context) =>
        context.contextType === probe.contextType && context.contextId === probe.contextId
    );
  if (!matchesContext) {
    return { kind: 'conflict', meetingId: existing.id };
  }

  return { kind: 'match', meeting: existing };
}

/**
 * BAL-400 (Decision 7) — the idempotent-replay check, run BEFORE `bookMeeting`.
 *
 * Returns the already-provisioned result when `key` resolves to THIS booking (same context,
 * same window — see {@link lookupBookingReplay}); `null` when no meeting exists under `key`
 * yet — the caller must create one. Throws {@link BookingIdempotencyKeyConflictError} when the
 * key resolves to a different case or a different window (cross-user reuse is already
 * unreachable — the key is `sha256(userId:nonce)`).
 *
 * Goes through `provisionMeeting`, NEVER `bookMeeting`, on the replay path (D2/Decision 7):
 * the meeting already exists, so this only needs to (re-)stamp its venue, and it must not
 * re-run `enqueueAvailabilityCacheRebuild` — `provisionMeeting` does not call it.
 */
async function replayByIdempotencyKey(
  key: string,
  input: BookAndProvisionInput,
  log: FastifyBaseLogger,
  deps: ProvisionMeetingDeps
): Promise<BookAndProvisionResult | null> {
  const lookup = await lookupBookingReplay(key, input);
  if (lookup.kind === 'none') {
    return null;
  }
  if (lookup.kind === 'conflict') {
    throw new BookingIdempotencyKeyConflictError(lookup.meetingId);
  }
  const existing = lookup.meeting;

  const replayed = await provisionMeeting(
    existing.id,
    {
      contextType: input.contextType,
      engagementType: input.engagementType,
      distinctId: input.userId,
      trigger: 'replay',
      escalateFailure: true,
    },
    log,
    deps
  );
  if (replayed === undefined) {
    // The meeting existed a moment ago and no longer does (soft-deleted between the two
    // reads) — an extremely narrow race. Let this 500 rather than silently minting a SECOND
    // meeting for a key that already names a durable (now-vanished) row.
    throw new Error(`Meeting ${existing.id} vanished during idempotent replay`);
  }

  return {
    meeting: existing,
    provisioned: replayed.provisioned,
    dailyRoomName: replayed.dailyRoomName,
    joinUrl: replayed.joinUrl,
  };
}

/**
 * BOOK then PROVISION — the route's entry point.
 *
 * The booking half is deliberately NOT wrapped in a `try` FOR `bookMeeting`'s OWN typed
 * errors (`MeetingExpertAmbiguousError`, `MatchModeDiscoveryNotBookableError`,
 * `MeetingContextUnresolvableError`, `MeetingContextNotProjectableError`,
 * `MeetingContextRequiredError`) — they MUST reach the route intact so it can map each to its
 * own status code. Catching here would flatten branchable reasons into one 500 — the same
 * rule `meeting-availability.ts`'s docblock states for itself.
 *
 * ⚠ THE ONE THING THIS FUNCTION DOES CATCH: a bare Postgres `23505` on
 * `meeting_booking_idempotency_key_idx` when `bookingIdempotencyKey` is present — the
 * concurrent-double-submit race (Decision 7 step 4). That is not a branchable "reason" for
 * the client; it means a racing request under the SAME key already won, so this call re-reads
 * and replays through it rather than surfacing the raw constraint violation as a 500.
 */
export async function bookAndProvisionMeeting(
  input: BookAndProvisionInput,
  log: FastifyBaseLogger,
  deps: ProvisionMeetingDeps = {}
): Promise<BookAndProvisionResult> {
  if (input.bookingIdempotencyKey !== undefined) {
    const replay = await replayByIdempotencyKey(input.bookingIdempotencyKey, input, log, deps);
    if (replay !== null) {
      return replay;
    }
  }

  let created: CreatedMeeting;
  try {
    created = await bookMeeting(
      {
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
        contexts: [{ contextType: input.contextType, contextId: input.contextId }],
        // ⚠ THE ONLY DURABLE RECORD OF WHO BOOKED (BAL-129, ADR-1044 §5). `userId` is otherwise
        // spent entirely on PostHog's `distinct_id` and the Pino/Axiom log — and `trackServer`
        // is a silent no-op without `POSTHOG_API_KEY`, so on a deployment without analytics the
        // booking actor would reach NO durable store at all. `create` folds this into a
        // `meeting.booked` audit row on the booking's own transaction.
        actorUserId: input.userId,
        bookingIdempotencyKey: input.bookingIdempotencyKey ?? null,
      },
      log
    );
  } catch (error) {
    if (input.bookingIdempotencyKey !== undefined && isUniqueViolation(error)) {
      const replay = await replayByIdempotencyKey(input.bookingIdempotencyKey, input, log, deps);
      if (replay !== null) {
        return replay;
      }
    }
    throw error;
  }

  const venue = await provisionVenue(
    created.meeting,
    {
      contextType: input.contextType,
      engagementType: input.engagementType,
      distinctId: input.userId,
      trigger: 'booking',
      escalateFailure: true,
    },
    log,
    deps
  );

  // BAL-400 (D2) / BAL-283 / BAL-433 / BAL-475 — the calendar pipeline, run ONLY on a fresh
  // create and never on a replay: `provisionMeeting` (the replay path) never reaches here,
  // matching the availability-cache rebuild's own "the replay path skips it anyway" rule —
  // re-running this on a replay would call `events.create` a SECOND time and, per apiroc
  // skill §M1, could strand a first vendor event rather than merely re-stamping Balo's own
  // row (and would enqueue a duplicate pair of calendar invites).
  //
  // ⚠ NO GATE. As of BAL-433 EVERY bookable context projects — the registry
  // (`services/consultation-events/calendar-context-registry.ts`) is TOTAL over
  // `MeetingBookingContextType`, so a sixth bookable label fails `tsc` there rather than
  // silently reaching no calendar. `isCalendarProjectedContext` is gone; do not reintroduce
  // one, and do not re-add a per-context resolver here — the pipeline lives under
  // `services/consultation-events/` and `services/calendar-invites/`.
  //
  // ⚠ IT NEVER THROWS (D2c) — the booking above has already committed and must not be undone
  // by a best-effort projection or a best-effort invite publish. See
  // `runPostCommitCalendarSteps`'s own docblock for the step order (load-bearing: the invite
  // publisher reads the rows the first two steps write).
  await runPostCommitCalendarSteps(created, input, log);

  return { meeting: created.meeting, ...venue };
}

/**
 * BAL-475 — expert projection → client row → both analytics emits → invites. Order is
 * load-bearing: `publishBookingCalendarInvites` READS the LIVE `meeting_calendar_events` rows
 * the first two steps write, so it must run after both. Extracted from
 * `bookAndProvisionMeeting` purely to keep that function under SonarCloud's cognitive-
 * complexity limit — every line here was inline there before this ticket. Never throws:
 * `projectBookingCalendarEventSafely`, `recordClientCalendarEntry` and
 * `publishBookingCalendarInvites` each own that contract independently.
 */
async function runPostCommitCalendarSteps(
  created: CreatedMeeting,
  input: BookAndProvisionInput,
  log: FastifyBaseLogger
): Promise<void> {
  // ⚠ `input.contextType` is a `MeetingBookingContextType`; `projectBookingCalendarEvent` /
  // `recordClientCalendarEntry` / `publishBookingCalendarInvites` each take a
  // `CalendarProjectedContextType`. Today the `Extract` makes them identical, so every call
  // below compiles with NO cast and NO runtime branch. If the two ever drift, THIS FUNCTION is
  // where `tsc` says so — the exhaustiveness guarantee working.
  const expertDelivery = await projectBookingCalendarEventSafely(created, input, log);
  trackServer(MEETING_SERVER_EVENTS.MEETING_CALENDAR_PROJECTED, {
    meeting_id: created.meeting.id,
    context_type: input.contextType,
    party: 'expert',
    delivery: expertDelivery,
    distinct_id: input.userId,
  });

  const clientDelivery = await recordClientCalendarEntry(
    created.meeting.id,
    input.contextType,
    input.contextId,
    log
  );
  trackServer(MEETING_SERVER_EVENTS.MEETING_CALENDAR_PROJECTED, {
    meeting_id: created.meeting.id,
    context_type: input.contextType,
    party: 'client',
    delivery: clientDelivery,
    distinct_id: input.userId,
  });

  await publishBookingCalendarInvitesSafely(created, input, log);
}

/**
 * The projection call, with the call site's own belt on top of its braces.
 *
 * ⚠ `projectBookingCalendarEvent`'s CONTRACT IS ALREADY "NEVER THROWS" (ADR-1044 D2c) and its
 * two callees each own a `try`/`catch`. This wrapper is DEFENCE IN DEPTH, kept deliberately
 * across BAL-433's refactor: before it, the per-context resolvers lived in this module and
 * each carried its own `catch`, so a violation of that contract could not turn a COMMITTED
 * booking into a rejected promise. `POST /meetings` maps an unrecognised throw to a 500 — and
 * this module's header is explicit that telling the client "this failed" about a booking that
 * exists and blocks an expert is the WORST of the available outcomes, because the user rebooks
 * and now two slots are blocked. Losing that guarantee to a refactor would have been silent.
 *
 * It reports `'failed'` — the same value the projection itself returns for a swallowed error —
 * so the analytics emit stays unconditional and one outcome vocabulary covers both paths.
 */
async function projectBookingCalendarEventSafely(
  created: CreatedMeeting,
  input: BookAndProvisionInput,
  log: FastifyBaseLogger
): Promise<ExpertCalendarDelivery> {
  try {
    return await projectBookingCalendarEvent(created, input.contextType, input.contextId, log);
  } catch (error) {
    log.error(
      {
        meetingId: created.meeting.id,
        // ⚠ `party` + `deliveryMode` ARE THE CORRELATION KEYS, NOT DECORATION. This path
        // returns BEFORE `projectBookingCalendarEvent` can emit its outcome line, so this is
        // the ONLY Axiom record of a contract-violation projection. Without these two keys an
        // Axiom query filtered on `deliveryMode` silently undercounts failures — while the
        // PostHog emit at the call site carries both, so the two sources would disagree
        // exactly when someone is debugging an incident. ⚠ NO `sequence` HERE, STILL — BAL-475
        // put SEQUENCE on the calendar-invite publish/delivery lines, never on a PROJECTION
        // line; this line reports a projection, not a send.
        party: 'expert',
        deliveryMode: 'failed' satisfies ExpertCalendarDelivery,
        contextType: input.contextType,
        contextId: input.contextId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'The expert calendar projection threw despite its never-throws contract — booking stands'
    );
    return 'failed';
  }
}

/**
 * BAL-475 — `publishBookingCalendarInvites`'s own contract is ALREADY "never throws" (every
 * one of its three publishers try/catches its per-recipient enqueue). This wrapper is DEFENCE
 * IN DEPTH, matching `projectBookingCalendarEventSafely`'s precedent immediately above: a
 * violation of that contract must still never turn a COMMITTED booking into a rejected
 * promise. Logged and swallowed, never rethrown.
 */
async function publishBookingCalendarInvitesSafely(
  created: CreatedMeeting,
  input: BookAndProvisionInput,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    await publishBookingCalendarInvites(
      {
        meetingId: created.meeting.id,
        contextType: input.contextType,
        expertProfileId: created.expertProfileId,
      },
      log
    );
  } catch (error) {
    log.error(
      {
        meetingId: created.meeting.id,
        contextType: input.contextType,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Calendar invite publish threw despite its never-throws contract — booking stands'
    );
  }
}
