import { Worker, type Job } from 'bullmq';
import {
  db,
  meetingContextsRepository,
  meetingPresenceRepository,
  meetingRecordingsRepository,
  meetingsRepository,
  resolveMeetingContextOwner,
  type Meeting,
  type MeetingPresence,
} from '@balo/db';
import { MEETING_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import { createLogger } from '@balo/shared/logging';
import {
  clampIntervalsToStart,
  computeMeetingClocks,
  dailyParticipantIdFor,
  dailyRoomNameForMeeting,
  expertClockStart,
  latestPresenceInstant,
  LIFECYCLE_LOOKBACK_MS,
  meetingVenueReadyAt,
  noShowHeldByLinkGuest,
  overrunStopCeiling,
  resolveTerminalRule,
  selectPrimaryMeetingContext,
  strandedEndedAt,
  strandedReconcileCloseAt,
  summarisePresence,
  venueAbsenceAnchor,
  type MeetingTerminalDecision,
  type MeetingTimers,
  type PresenceFacts,
} from '@balo/shared/meetings';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { resolveMeetingTimers } from '../config/meeting-timers.js';
import {
  dailyPresenceReader,
  dailyRoomTeardown,
  type PresenceReader,
} from '../services/daily/rooms.js';
import {
  scheduleClientAbsentNudge,
  scheduleExpertAbsentAlert,
} from '../notifications/scheduling/meeting-absence.js';
import { emitMeetingEnded } from '../services/meetings/end-meeting.js';
import { isReleasedSettlementCode } from '../services/credit-session/released-settlement-codes.js';
import { settleSessionlessCaseMeeting } from '../services/credit-session/settle-sessionless-case-meeting.js';
import {
  applyPresenceEffect,
  closePresenceEffectForRow,
  reconcileMeetingStatus,
  resolvePresenceEffect,
} from '../services/meetings/presence-writer.js';
import { deliveringPartyName } from '../services/meetings/delivering-party.js';
import {
  enqueueRecordingEnsure,
  enqueueRecordingStop,
  MAX_DAILY_FAILURES_PER_MEETING,
} from './recording-capture.js';

/**
 * BAL-134 (§5.6) — THE PER-MINUTE MEETING LIFECYCLE SWEEP. Modelled on
 * `credit-session-meter-sweep.ts`, including its per-row try/catch discipline.
 *
 * Three passes per tick, in this order:
 *
 *   1. **RECONCILE** — leg 2 of D1. ONE `GET /presence` call for the whole platform, then per
 *      candidate: close every open interval whose participant the vendor does not confirm, and
 *      open one for a vendor participant Balo has none for (a dropped `participant.joined`). A
 *      candidate holding open intervals whose room the platform-wide map does not list gets ONE
 *      validated per-room read instead (see {@link resolveRoomRoster}); a STRANDED candidate
 *      (below the lookback floor) is close-only, and its closes land at Daily's RECORDED LEAVE
 *      for the participant (one capped session-history read per candidate, see
 *      {@link readStrandedLeaves}), never at the tick that noticed.
 *      ⚠ A pass that changed anything then RE-READS the meeting and runs
 *      `reconcileMeetingStatus`, so the FORWARD status transitions are repaired too — see
 *      `repairStatusAndReload` for the stranding that omitting this produced.
 *   2. **TERMINATE** — `resolveTerminalRule` per candidate; on a match, `endMeeting` + the
 *      matching analytics event.
 *   3. **ARM** — the two absence promises, `first_wins` so repeated ticks are a cheap no-op.
 *
 * ── ⚠⚠ WHY RECONCILIATION EXISTS AT ALL, AND WHAT IT BUYS ───────────────────────────────
 *
 * `meeting_presence`'s docblock names the DROPPED `participant.left` as **the** over-bill
 * hazard: an interval left open is measured against `now` forever, so a call that ran
 * 10:00→10:30 with both leave webhooks dropped would settle as a SIXTEEN-HOUR call if a job
 * read it at 02:00. Four layers close it, and this pass is the one that BOUNDS it:
 *
 *   · this reconciliation runs every minute, so the worst-case over-measurement is ONE TICK
 *     (≤60s) — a bounded, known, DOCUMENTED over-bill rather than a silent unbounded one;
 *   · the `meeting.ended` webhook closes the common case in under a second;
 *   · every terminal transition closes all open intervals INSIDE its own transaction;
 *   · `meetings.ended_at` then becomes the ceiling `resolveClockCeiling` prefers.
 *
 * ⚠ EVERY INTERVAL THIS PASS CLOSES IS A DROPPED WEBHOOK, so each one logs at `warn` — the RATE
 * is the health signal for the whole presence model, and it is the only place that signal
 * exists.
 *
 * ── ⚠ WHAT THIS JOB DOES NOT DO ─────────────────────────────────────────────────────────
 *
 * It does not settle, charge, or price anything — BAL-412 owns that. It writes no
 * `consultations` projection row and triggers no availability rebuild: an `ended` meeting KEEPS
 * occupying the expert's calendar slot, because the booked window WAS consumed
 * (`consultationStatusForMeeting` maps every non-`cancelled` label to `confirmed`). A reviewer
 * will otherwise read that absence as a miss.
 */
export const MEETING_LIFECYCLE_SWEEP_QUEUE = 'meeting-lifecycle-sweep';
export const MEETING_LIFECYCLE_SWEEP_CRON = '* * * * *'; // every minute

/**
 * ⚠ A LOOKBACK FLOOR, NOT A WINDOW. It bounds the IN-WINDOW batch: scanning every non-terminal
 * meeting ever created each minute would grow without bound. A non-terminal meeting older than
 * the floor is the STRANDED arm's
 * (`meetingsRepository.listStrandedLifecycleCandidates`, capped at
 * {@link MEETING_STRANDED_BATCH_LIMIT}), which repairs it close-only. Defined in
 * `@balo/shared/meetings` (the timer coherence check bounds the overrun ceiling by it) and
 * re-exported here for `case-inactivity-sweep.test.ts`, which pins
 * `MEETING_TOKEN_TTL_AFTER_END_MS >= LIFECYCLE_LOOKBACK_MS`.
 */
export { LIFECYCLE_LOOKBACK_MS };

/** ⚠ THE CALLER MUST WARN WHEN THIS FILLS — the no-silent-caps rule. It does, below. */
export const MEETING_LIFECYCLE_BATCH_LIMIT = 200;

/** The stranded arm's batch bound. ⚠ The sweep warns when it fills, same as the in-window one. */
export const MEETING_STRANDED_BATCH_LIMIT = 50;

/**
 * ⚠ THE RECONCILER'S CLOSE CAP PER TICK. Every close is a dropped `participant.left`, so a tick
 * that wants more than this is itself an anomaly (a vendor misread, not a thousand dropped
 * webhooks). Closes past the cap wait for the next tick, and the sweep logs at `error` when it
 * is hit. A terminal rule's own `closeAllOpen` is NOT counted: that close is the end of the
 * meeting, not a reconciliation.
 */
export const MAX_RECONCILER_CLOSES_PER_TICK = 25;

/**
 * ⚠ THE PER-ROOM PRESENCE READ CAP PER TICK. `GET /rooms/:name/presence` sits in Daily's 20/s
 * per-room tier, and Daily's platform-wide map never lists an EMPTY room, so every close of an
 * empty room needs one of these reads. Candidates past the cap are UNKNOWN this tick (nothing
 * is closed on a guess) and the sweep warns with the deferred count. 20 reads stay below the 25
 * closes, so this cap fills first. Counted per READ, and a read of an empty room is up to two
 * SEQUENTIAL calls (the presence list, then the room-exists check, see `getRoomPresence`), which
 * stays far below Daily's 20/s tier.
 */
export const MAX_ROOM_PRESENCE_READS_PER_TICK = 20;

/**
 * ⚠ THE SESSION-HISTORY READ CAP PER TICK. `GET /meetings?room=` sits in Daily's analytics rate
 * tier (~2/s, 50 per 30s), a far tighter tier than the 20/s the per-room presence read lives in,
 * so it has its own cap. One read per STRANDED candidate that has an identity-bearing interval to
 * close, never for an in-window candidate. 5 reads a tick is 5 per 60s: about 0.08/s against the
 * ~2/s tier, and 5 of the 50-per-30s allowance, leaving the rest of the tier to everything else
 * that reads `/meetings`. A strand backlog drains five meetings a minute, which is slower than
 * the 50-row stranded batch but fine for a population that is rare. A candidate past the cap
 * skips reconciliation AND its terminal rules for the tick (it stays selected, oldest first, and
 * retries), and the sweep warns with the deferred count. A history read that FAILS is not a
 * deferral: the closes fall back to the booked end and the terminal rules run.
 */
export const MAX_SESSION_HISTORY_READS_PER_TICK = 5;

/** `scheduled_start − this` is where the session-history read starts looking. */
const SESSION_HISTORY_LEAD_MS = 60 * 60 * 1000;

/**
 * ⚠⚠ BAL-480 — THE CROSS-MEETING FAN-OUT BOUND, AND THE ONE THIS FEATURE ITSELF CREATES.
 * `POST /rooms/:name/recordings/start` sits in Daily's TIGHTEST tier — ~1/s (5 per 5s), against
 * 20/s for everything else (`.claude/skills/daily-co/SKILL.md`, "Rate limits"). Steady state is
 * free (a healthy meeting is suppressed by `needsRecordingEnsure` and makes no Daily call at
 * all), so the exposure is the RECOVERY THUNDERING HERD — a Daily outage ends and the next tick
 * tries to start a recording for every affected meeting at once, up to
 * `MEETING_LIFECYCLE_BATCH_LIMIT`.
 *
 * ⚠ EXCEEDING THE TIER IS NOT MERELY SLOW, IT IS DESTRUCTIVE. A `429` is retryable
 * (`isUnrecoverableDailyError` exempts it), but `recording-capture.ts`'s §5.1b stamps a `failed`
 * row on EVERY attempt BEFORE rethrowing — so a rate-limit storm burns
 * `MAX_DAILY_FAILURES_PER_MEETING` and disables recording for the rest of those meetings. The cap
 * exists to stop the feature from doing that to itself.
 *
 * 20/min = 0.33/s leaves two thirds of the sustained tier for the LATENCY-SENSITIVE
 * webhook-origin ensures (a real rejoin must record now, not next minute). A full 200-candidate
 * herd drains in ten sweep minutes, and a reap can only recur once per
 * `STUCK_CAPTURE_THRESHOLD_MS` per meeting anyway, so the queue self-drains: a meeting served
 * this tick is suppressed on the next.
 *
 * ⚠ THE CALLER MUST WARN WHEN THIS FILLS — the no-silent-caps rule, same as the batch limit. It
 * does, below.
 */
export const MAX_RECORDING_ENSURES_PER_SWEEP_TICK = 20;

const logger = createLogger('meeting-lifecycle-sweep');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The facts every pass needs about one candidate, read once per tick per meeting. */
interface CandidateState {
  readonly meeting: Meeting;
  readonly facts: PresenceFacts;
  readonly expertPresentMs: number;
  /** An admitted `link` guest holds an open interval; see `noShowHeldByLinkGuest`. */
  readonly admittedLinkGuestPresent: boolean;
  /** The latest instant any live interval records — the floor of a stranded `ended_at`. */
  readonly latestPresenceAt: Date | null;
  /** The intervals with no `leftAt`, in join order — the rows reconciliation may close. */
  readonly openRows: readonly MeetingPresence[];
}

async function loadCandidateState(meeting: Meeting, now: Date): Promise<CandidateState> {
  const rows = await meetingPresenceRepository.listByMeeting(meeting.id);
  const intervals = rows.map((row) => ({
    party: row.party,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt,
  }));
  // The extra read is paid only when an open observer interval belongs to a guest, so a healthy
  // meeting costs no extra query.
  const mayHaveLinkGuest = rows.some(
    (row) => row.leftAt === null && row.meetingGuestId !== null && row.party === 'observer'
  );
  const admittedLinkGuestPresent =
    mayHaveLinkGuest && (await meetingPresenceRepository.hasOpenAdmittedLinkGuest(meeting.id));
  return {
    meeting,
    admittedLinkGuestPresent,
    facts: summarisePresence(intervals),
    latestPresenceAt: latestPresenceInstant(intervals),
    openRows: rows.filter((row) => row.leftAt === null),
    // ⚠ REPORTING ONLY — no terminal rule reads a DURATION. `computeMeetingClocks` is the one
    // definition of the two spans, and this number reaches the `meeting_waiting_abandoned` event
    // and the "Terminal rule fired" log line, never a decision. Rule 4 once compared it against
    // the no-show floor; that comparison was the C2 stranding hole (`lifecycle.ts`).
    // Presence is stored at its true instants (Rule A): the figure is over start-CLAMPED intervals.
    expertPresentMs: computeMeetingClocks(
      clampIntervalsToStart(intervals, meeting.scheduledStart),
      now
    ).expertPresentMs,
  };
}

/**
 * What the Daily roster said about a meeting's room at the moment of a stop.
 *
 * `unknown` is every read that could not be trusted (a failed or rejected vendor call, an
 * un-provisioned room, a spent cap); a read that returned zero participants is `empty`.
 */
export type RoomOccupancy = 'occupied' | 'empty' | 'unknown';

/**
 * What the sweep learned about ONE candidate's room this tick.
 *
 * `unknown` — nothing trustworthy; reconciliation is skipped. `platform` — the room is a key in
 * Daily's platform-wide map (or the candidate holds nothing open, so nothing needs reading).
 * `room` — a validated per-room read. `participants` are the Daily `userId`s (an id-less
 * participant has none to give), while `vendorCount` is the RAW count, so a participant with no
 * `userId` still makes the room occupied.
 *
 * ⚠ "CONFIRMED EMPTY" IS `source === 'room' && vendorCount === 0` AND NOTHING ELSE — the only
 * read that licenses closing an interval that has no identity to match.
 */
export type RoomRosterRead =
  | {
      readonly source: 'unknown';
      /**
       * The read was skipped only because one of the sweep's own per-tick budgets (close, history
       * read or per-room read) is spent: our own budget, not Daily.
       */
      readonly ownBudgetSpent?: true;
    }
  | {
      readonly source: 'platform' | 'room';
      readonly participants: readonly string[];
      readonly vendorCount: number;
    };

const UNKNOWN_ROSTER: RoomRosterRead = { source: 'unknown' };
const OWN_BUDGET_SPENT_ROSTER: RoomRosterRead = { source: 'unknown', ownBudgetSpent: true };

/** @see RoomOccupancy */
export function roomOccupancy(read: RoomRosterRead): RoomOccupancy {
  if (read.source === 'unknown') {
    return 'unknown';
  }
  return read.vendorCount === 0 ? 'empty' : 'occupied';
}

/** `in_window` candidates are reconciled both ways; `stranded` ones are close-only. */
type SweepMode = 'in_window' | 'stranded';

/**
 * The per-tick budget for the reconciler's closes and the per-room reads, carried as ONE MUTABLE
 * ACCUMULATOR and spent BEFORE each write or vendor call (the same shape as
 * {@link RecordingEnsureBudget}). One instance spans both batches, so live meetings, processed
 * first, get priority on both caps.
 */
interface ReconcileBudget {
  closesSpent: number;
  closesDeferred: number;
  roomReadsSpent: number;
  roomReadsDeferred: number;
  historyReadsSpent: number;
  historyReadsDeferred: number;
}

/** Everything a candidate needs that is the same for the whole tick. */
interface SweepContext {
  readonly platform: PlatformRosterRead;
  readonly reader: PresenceReader;
  readonly budget: ReconcileBudget;
  readonly timers: MeetingTimers;
  readonly now: Date;
}

/**
 * Resolve what Daily says about one candidate's room. The first matching step wins.
 *
 * ⚠⚠ `unknown` IS NOT "THE ROOM IS EMPTY", AND CONFLATING THE TWO WOULD BE THE WORST BUG IN THIS
 * FILE. A Daily outage, a `429`, a body this platform cannot interpret, a spent cap or an
 * un-provisioned meeting all yield no roster, and reading that as an empty room would close
 * EVERY open interval on EVERY live meeting in one tick. Reconciliation is skipped instead; the
 * terminal rules still run and a later tick with a real roster repairs what drifted.
 *
 * ⚠ DAILY'S PLATFORM-WIDE MAP NEVER LISTS AN EMPTY ROOM, so an absent room is not thereby known
 * to be empty, and a whole-map-empty answer is no longer a reason to stop: a candidate that
 * holds open intervals and is absent from the map gets ONE validated `getRoomPresence`. Only
 * that read returning zero participants is confirmed empty. It is made only when the
 * platform-wide read itself succeeded, so an outage never fans out into per-room calls.
 */
async function resolveRoomRoster(
  meeting: Meeting,
  open: readonly MeetingPresence[],
  mode: SweepMode,
  ctx: SweepContext
): Promise<RoomRosterRead> {
  const openCount = open.length;
  const { platform, reader, budget } = ctx;
  const roomName = meeting.dailyRoomName;
  if (!platform.rosterAvailable || roomName === null) {
    return UNKNOWN_ROSTER;
  }
  const listed = platform.rooms.get(roomName);
  if (listed !== undefined) {
    return { source: 'platform', participants: listed.userIds, vendorCount: listed.count };
  }
  if (openCount === 0) {
    // Nothing is open, so there is nothing to close and no read to spend.
    return { source: 'platform', participants: [], vendorCount: 0 };
  }
  if (roomName !== dailyRoomNameForMeeting(meeting.id)) {
    // The stamped name is a pure function of `meetings.id`; a divergence means this row points
    // at a room it may not own, and a per-room read of it could not be trusted to close anything.
    logger.warn(
      { meetingId: meeting.id, roomName },
      'Stamped Daily room name disagrees with the derived one — treating the room as UNKNOWN and skipping the per-room read'
    );
    return UNKNOWN_ROSTER;
  }
  if (
    mode === 'stranded' &&
    budget.historyReadsSpent >= MAX_SESSION_HISTORY_READS_PER_TICK &&
    open.some((row) => claimFor(row.userId, row.meetingGuestId) !== null)
  ) {
    // A confirmed-empty answer would lead straight to a session-history read, and that budget is
    // spent: do not spend a room read on a candidate that cannot be repaired this tick.
    budget.historyReadsDeferred += 1;
    return OWN_BUDGET_SPENT_ROSTER;
  }
  if (budget.closesSpent >= MAX_RECONCILER_CLOSES_PER_TICK) {
    // A read here could only feed a close, and the close cap is already spent.
    budget.closesDeferred += openCount;
    return OWN_BUDGET_SPENT_ROSTER;
  }
  if (budget.roomReadsSpent >= MAX_ROOM_PRESENCE_READS_PER_TICK) {
    budget.roomReadsDeferred += 1;
    return OWN_BUDGET_SPENT_ROSTER;
  }
  budget.roomReadsSpent += 1;
  try {
    const participants = await reader.getRoomPresence(roomName);
    return {
      source: 'room',
      participants: participants.flatMap((participant) =>
        typeof participant.userId === 'string' ? [participant.userId] : []
      ),
      vendorCount: participants.length,
    };
  } catch (error) {
    logger.warn(
      { meetingId: meeting.id, roomName, error: errorMessage(error) },
      'Daily per-room presence read failed — treating the room as UNKNOWN and skipping reconciliation'
    );
    return UNKNOWN_ROSTER;
  }
}

/**
 * The OPEN half of reconciliation: open an interval for every vendor participant Balo holds none
 * for (a dropped `participant.joined`). In-window candidates only — see {@link reconcileMeeting}.
 */
async function openMissingParticipants(
  meeting: Meeting,
  open: readonly MeetingPresence[],
  vendorIds: ReadonlySet<string>,
  now: Date
): Promise<number> {
  let opened = 0;
  const openClaims = new Set(
    open.flatMap((row) => {
      const claim = claimFor(row.userId, row.meetingGuestId);
      return claim === null ? [] : [claim];
    })
  );
  for (const claim of vendorIds) {
    if (openClaims.has(claim)) {
      continue;
    }
    const effect = await resolvePresenceEffect({
      action: 'open',
      meeting,
      participantId: claim,
      at: now,
    });
    if ((await applyPresenceEffect(db, effect)) === 'opened') {
      opened += 1;
      logger.warn(
        { meetingId: meeting.id, participantId: claim },
        'Reconciler opened an interval for a vendor participant Balo had none for — a dropped webhook'
      );
    }
  }
  return opened;
}

/** What {@link strandedLeavesFor} resolved for one stranded candidate. */
type StrandedLeaves =
  | { readonly kind: 'leaves'; readonly leaves: ReadonlyMap<string, Date> }
  /** Our own close or history-read budget is spent: the candidate is skipped entirely this tick. */
  | { readonly kind: 'deferred' };

const NO_LEAVES: StrandedLeaves = { kind: 'leaves', leaves: new Map() };

/**
 * The recorded leaves a stranded candidate's closes need, behind two short-circuits that make no
 * history read: nothing closable, and every closable interval identity-less (they bill nothing
 * and take the booked-end fallback). Otherwise ONE capped read.
 *
 * ⚠ A STRANDED CLOSE LANDS WHERE THE PARTICIPANT LEFT, not at the tick that noticed. The read
 * counts against neither the close cap nor the per-room read cap.
 *
 * ⚠ ONLY OUR OWN BUDGET DEFERS A CANDIDATE. A failing or unparseable history read falls back to
 * the booked end (`NO_LEAVES`), because a persistently failing endpoint must never stall
 * termination. A spent close cap or history-read cap is our own budget, so it defers the
 * candidate: neither a close nor a terminal rule runs this tick.
 *
 * ⚠ A SESSION DAILY STILL CALLS `ongoing` IS NOT UNKNOWN. This runs only for a room confirmed
 * empty (an occupied room never reaches it), so an `ongoing` session there is Daily's
 * finalisation lag; the reader returns that session's recorded leave when it has a finite
 * duration, and the booked end applies when it has none.
 */
async function strandedLeavesFor(
  meeting: Meeting,
  closable: readonly MeetingPresence[],
  ctx: SweepContext
): Promise<StrandedLeaves> {
  const { budget, reader } = ctx;
  const roomName = meeting.dailyRoomName;
  if (closable.length === 0 || roomName === null) {
    return NO_LEAVES;
  }
  if (budget.closesSpent >= MAX_RECONCILER_CLOSES_PER_TICK) {
    budget.closesDeferred += closable.length;
    return { kind: 'deferred' };
  }
  const claims = closable.flatMap((row) => {
    const claim = claimFor(row.userId, row.meetingGuestId);
    return claim === null ? [] : [claim];
  });
  if (claims.length === 0) {
    return NO_LEAVES;
  }
  if (budget.historyReadsSpent >= MAX_SESSION_HISTORY_READS_PER_TICK) {
    budget.historyReadsDeferred += 1;
    return { kind: 'deferred' };
  }
  budget.historyReadsSpent += 1;
  try {
    const history = await reader.getRoomSessionLeaves(roomName, {
      since: new Date(meeting.scheduledStart.getTime() - SESSION_HISTORY_LEAD_MS),
    });
    return { kind: 'leaves', leaves: history.leaves };
  } catch (error) {
    logger.warn(
      { meetingId: meeting.id, roomName, error: errorMessage(error) },
      'Daily session-history read failed — closing the stranded intervals at the booked end'
    );
    return NO_LEAVES;
  }
}

/**
 * What {@link reconcileMeeting} did. `verdict` is `reconciled` normally and `deferred` when a
 * stranded candidate is skipped outright on one of the sweep's own per-tick budgets.
 */
interface ReconcileOutcome {
  closed: number;
  opened: number;
  verdict: 'reconciled' | 'deferred';
}

const NOTHING_RECONCILED: ReconcileOutcome = { closed: 0, opened: 0, verdict: 'reconciled' };

/**
 * PASS 1 — reconcile ONE meeting against the vendor's roster.
 *
 * ⚠ THE VENDOR ROSTER IS USED ONLY TO DECIDE **WHETHER** AN INTERVAL SHOULD BE OPEN OR CLOSED —
 * never to decide WHOSE it is. `party` is still derived server-side by `resolvePresenceEffect`
 * from Balo's own tables, because it is a billing input (see the presence writer's docblock).
 *
 * ⚠ A STRANDED MEETING IS CLOSE-ONLY. The OPEN half would reach `reconcileMeetingStatus`, whose
 * forward transitions (`markInProgress`, `startBillingIfDue`) must never run on a meeting that
 * fell behind the lookback floor. Its closes land at {@link strandedReconcileCloseAt}: Daily's
 * recorded leave for the participant, else the booked end. Closing at the tick instant would
 * record days of presence and, pre-live, settle a charge for them. When the recorded leaves
 * cannot be read, the closes fall back to the booked end; only a spent history-read budget skips
 * the candidate (see {@link strandedLeavesFor}).
 */
async function reconcileMeeting(
  state: CandidateState,
  open: readonly MeetingPresence[],
  read: RoomRosterRead,
  mode: SweepMode,
  ctx: SweepContext
): Promise<ReconcileOutcome> {
  if (read.source === 'unknown') {
    return NOTHING_RECONCILED;
  }
  if (mode === 'stranded' && read.source === 'platform') {
    // ⚠ A ROOM THE PLATFORM LISTS IS REAL OCCUPANCY, not a strand to repair: no history read and
    // no closes. The terminal rules run on the occupancy as read.
    return NOTHING_RECONCILED;
  }
  const { meeting } = state;
  const { now } = ctx;
  const vendorIds = new Set(read.participants);
  const confirmedEmpty = read.source === 'room' && read.vendorCount === 0;

  const closable = closableIntervals(open, vendorIds, confirmedEmpty);

  const resolved: StrandedLeaves =
    mode === 'stranded' ? await strandedLeavesFor(meeting, closable, ctx) : NO_LEAVES;
  if (resolved.kind === 'deferred') {
    return { closed: 0, opened: 0, verdict: 'deferred' };
  }
  const { leaves } = resolved;

  const { closed, closeCapSkipped } = await closeWithinBudget(meeting, closable, mode, leaves, ctx);

  if (mode === 'stranded') {
    // ⚠ A ROW SKIPPED ON OUR OWN CLOSE CAP DEFERS THE CANDIDATE, but the closes that landed stand
    // and are reported, so a meeting with more open rows than the cap still progresses each tick.
    return { closed, opened: 0, verdict: closeCapSkipped ? 'deferred' : 'reconciled' };
  }

  const opened = await openMissingParticipants(meeting, open, vendorIds, now);
  return { closed, opened, verdict: 'reconciled' };
}

/**
 * The open intervals the roster does not confirm.
 *
 * ⚠ AN INTERVAL WITH NO IDENTITY CANNOT BE RECONCILED AGAINST A ROSTER — there is nothing to
 * match. It is `observer` by construction, so it bills nothing either way, and closing it on
 * a guess would be worse than leaving it. The ONE exception is a confirmed-empty room: with
 * nobody in it, no roster entry could be this interval's, so it is closed by identity-less
 * match (one row per call).
 */
function closableIntervals(
  open: readonly MeetingPresence[],
  vendorIds: ReadonlySet<string>,
  confirmedEmpty: boolean
): MeetingPresence[] {
  return open.filter((row) => {
    const claim = claimFor(row.userId, row.meetingGuestId);
    return claim === null ? confirmedEmpty : !vendorIds.has(claim);
  });
}

/**
 * Closes `closable` while the per-tick close cap allows; a row past the cap waits for the next
 * tick (`closeCapSkipped`). An in-window close lands at the tick instant, a stranded one at
 * {@link strandedCloseInstant}.
 */
async function closeWithinBudget(
  meeting: Meeting,
  closable: readonly MeetingPresence[],
  mode: SweepMode,
  leaves: ReadonlyMap<string, Date>,
  ctx: SweepContext
): Promise<{ closed: number; closeCapSkipped: boolean }> {
  const { budget, now } = ctx;
  let closed = 0;
  let closeCapSkipped = false;
  for (const row of closable) {
    const claim = claimFor(row.userId, row.meetingGuestId);
    if (budget.closesSpent >= MAX_RECONCILER_CLOSES_PER_TICK) {
      budget.closesDeferred += 1;
      closeCapSkipped = true;
      continue;
    }
    budget.closesSpent += 1;
    const closeAt =
      mode === 'stranded' ? strandedCloseInstant(meeting, row, claim, leaves, ctx) : now;
    if (await closeStaleInterval(meeting, row, claim, closeAt)) {
      closed += 1;
    }
  }
  return { closed, closeCapSkipped };
}

/** Where a stranded close lands: {@link strandedReconcileCloseAt} over the claim's recorded leave. */
function strandedCloseInstant(
  meeting: Meeting,
  row: MeetingPresence,
  claim: string | null,
  leaves: ReadonlyMap<string, Date>,
  ctx: SweepContext
): Date {
  return strandedReconcileCloseAt({
    joinedAt: row.joinedAt,
    recordedLeaveAt: claim === null ? null : (leaves.get(claim) ?? null),
    status: meeting.status,
    scheduledStart: meeting.scheduledStart,
    scheduledEnd: meeting.scheduledEnd,
    timers: ctx.timers,
    now: ctx.now,
  });
}

/** Closes one interval the roster does not confirm; `true` when the write closed it. */
async function closeStaleInterval(
  meeting: Meeting,
  row: MeetingPresence,
  claim: string | null,
  closeAt: Date
): Promise<boolean> {
  // ⚠ BUILT FROM THE STORED ROW, NOT RE-DERIVED. `close` matches on IDENTITY only, so the
  // party derivation a full `resolvePresenceEffect` would run — the participation gate plus a
  // delivery-identity read, per interval, per candidate, every minute — buys the write
  // nothing and could only introduce disagreement. See `closePresenceEffectForRow`.
  const effect = closePresenceEffectForRow(meeting, row, closeAt);
  if ((await applyPresenceEffect(db, effect)) !== 'closed') {
    return false;
  }
  // ⚠ EACH ONE IS A DROPPED `participant.left` WEBHOOK. The RATE is the health signal for
  // the whole presence model — this is the only place it is visible.
  logger.warn(
    { meetingId: meeting.id, participantId: claim, openedAt: row.joinedAt.toISOString() },
    'Reconciler closed an interval the vendor roster does not confirm — a dropped webhook'
  );
  return true;
}

/**
 * Rebuild the Daily `user_id` CLAIM for one stored interval, so it can be compared against the
 * vendor roster. ⚠ `null` for an interval with no identity — see `reconcileMeeting`.
 */
function claimFor(userId: string | null, meetingGuestId: string | null): string | null {
  // ⚠ THROUGH `dailyParticipantIdFor`, THE SHARED ENCODER — never a second `${tag}${id}`
  // spelling here. It is the same function the token minter uses, which is exactly what makes
  // the comparison against the vendor roster meaningful; a local copy that drifted would make
  // every reconciliation silently close intervals that ARE confirmed.
  if (userId !== null) {
    return dailyParticipantIdFor('user', userId);
  }
  if (meetingGuestId !== null) {
    return dailyParticipantIdFor('guest', meetingGuestId);
  }
  return null;
}

/**
 * Log what the sessionless settlement did on this sweep — one line per outcome that needs one. A
 * deferral is retried by the meter sweep's sessionless-meeting backstop; a refusal is permanent (the
 * meeting is marked and the refusal alarmed); a RELEASED settlement — either `released_closed_case_no_show`
 * (a no-show on a case closed before the start) or `released_expert_invited_guest_only` (a `held` call
 * attended only by client-party guests the delivering expert invited), see `isReleasedSettlementCode` — is
 * TERMINAL (`info`) and never retried; any other declined presence settlement is retried by the
 * presence-settlement backstop.
 */
function logSessionlessSettlement(
  meetingId: string,
  result: Awaited<ReturnType<typeof settleSessionlessCaseMeeting>>
): void {
  if (result.kind === 'deferred') {
    logger.warn(
      { meetingId, kind: result.kind, reason: result.reason },
      'Sessionless Case settlement deferred on the lifecycle sweep — the meter sweep sessionless-meeting backstop retries it'
    );
    return;
  }
  if (result.kind === 'refused') {
    logger.warn(
      { meetingId, kind: result.kind, reason: result.reason },
      'Sessionless Case settlement refused on the lifecycle sweep — permanent: the meeting is marked and the refusal alarmed, and nothing retries it'
    );
    return;
  }
  if (result.kind !== 'settled_existing_session' || result.outcome.ok) {
    return;
  }
  const { code } = result.outcome;
  if (isReleasedSettlementCode(code)) {
    logger.info(
      { meetingId, code },
      'Session released with nothing owed — released on the lifecycle sweep'
    );
  } else if (code !== 'no_meeting') {
    logger.warn(
      { meetingId, code },
      'Presence settlement declined on the lifecycle sweep — the meter sweep presence-settlement backstop will retry'
    );
  }
}

/**
 * PASS 2 — evaluate the six terminal rules and, on a match, end the meeting.
 *
 * ⚠ `ended_at` IS `now` FOR AN IN-WINDOW MEETING, AND THE INSTANT THE RULE BECAME DUE FOR A
 * STRANDED ONE ({@link strandedEndedAt}). A meeting that sat past the lookback floor for days
 * would otherwise record every one of those days as call time, because `endMeeting` closes the
 * open intervals at the `endedAt` it is handed. The settlement ceiling, the meeting-ended
 * analytics and the overrun stop's `minutes_past_scheduled_end` all read this one instant.
 */
async function terminateIfDue(
  state: CandidateState,
  timers: MeetingTimers,
  now: Date,
  occupancy: RoomOccupancy,
  mode: SweepMode
): Promise<MeetingTerminalDecision | null> {
  const ruleInput = {
    status: state.meeting.status,
    scheduledStart: state.meeting.scheduledStart,
    scheduledEnd: state.meeting.scheduledEnd,
    presence: state.facts,
    timers,
    now,
    venueReadyAt: meetingVenueReadyAt(state.meeting),
    admittedLinkGuestPresent: state.admittedLinkGuestPresent,
  };
  const decision = resolveTerminalRule(ruleInput);
  if (decision === null) {
    if (noShowHeldByLinkGuest(ruleInput)) {
      logger.debug(
        {
          meetingId: state.meeting.id,
          ceiling: overrunStopCeiling(ruleInput.scheduledStart, ruleInput.scheduledEnd, timers),
        },
        'No-show held — an admitted link guest is with the expert'
      );
    }
    return null;
  }
  let dueAt = decision.dueAt;

  if (decision.rule === 'venue_unavailable') {
    // ⚠⚠ BAL-581 — CONFIRM ON A FRESH ROW. Candidates are read once per tick, and a
    // roomless meeting skips reconciliation (its roster is `unknown`), so its snapshot is
    // never re-read by anything else. A repair whose `setVenue` lands after the batch read —
    // with a client already admitted to the fresh room — must not be ended `venue_unavailable`
    // on a stale "not ready" read, and its fresh room must not go undeleted below.
    const fresh = await meetingsRepository.findById(state.meeting.id);
    if (fresh === undefined) {
      // Soft-deleted between the batch read and now. Nothing to terminate.
      return null;
    }
    const confirmed = resolveTerminalRule({
      status: fresh.status,
      scheduledStart: fresh.scheduledStart,
      scheduledEnd: fresh.scheduledEnd,
      presence: state.facts,
      timers,
      now,
      venueReadyAt: meetingVenueReadyAt(fresh),
      admittedLinkGuestPresent: state.admittedLinkGuestPresent,
    });
    if (confirmed === null || confirmed.rule !== 'venue_unavailable') {
      // The next tick decides from fresh state — a repair landed, or the meeting moved on.
      return null;
    }
    dueAt = confirmed.dueAt;
  }

  const endedAt =
    mode === 'stranded'
      ? strandedEndedAt({
          dueAt,
          now,
          latestPresenceAt: state.latestPresenceAt,
          startedAt: state.meeting.startedAt,
        })
      : now;

  const ended = await meetingsRepository.endMeeting({
    id: state.meeting.id,
    outcome: decision.outcome,
    // ⚠ ALL SIX SYSTEM RULES REPORT `system_idle` — `ended_by` answers "person or system?", and
    // WHICH rule fired is answered by `outcome` plus the `meeting.ended` audit row's
    // `terminalRule` (`idle_end` and `overrun_stop` share `outcome='completed'`).
    endedBy: 'system_idle',
    endedAt,
    terminalRule: { rule: decision.rule, arm: decision.arm },
    // ⚠ NULL ACTOR — the ADR-1030 system-actor exemption. An unattributed audit row, never a
    // fabricated actor.
    actorUserId: null,
  });
  if (ended === undefined) {
    // Somebody pressed End in the same instant. A normal race, not an error.
    return null;
  }

  logger.info(
    {
      meetingId: state.meeting.id,
      rule: decision.rule,
      arm: decision.arm,
      outcome: decision.outcome,
      endedBy: 'system_idle',
      expertPresentMs: state.expertPresentMs,
    },
    'Terminal rule fired'
  );

  emitRuleAnalytics(state, decision, ended.meeting, {
    endedAt,
    occupancy,
    closedIntervals: ended.closedIntervals,
  });
  await emitMeetingEnded({
    meeting: ended.meeting,
    endedBy: 'system_idle',
    actorUserId: null,
    now: endedAt,
  });

  // ⚠⚠ BAL-412 (ADR-1044 §7) → BAL-474 (ADR-1040 Amendment 7 §C) — SETTLEMENT, FOR EVERY RULE.
  // `settleSessionlessCaseMeeting` settles the meeting's existing session from presence (BAL-466's
  // admission-opened one) OR — when a billable Case meeting has none — opens it on behalf of the
  // booker and settles it in ONE transaction. It is keyed on the presence SHAPE, not on which rule
  // fired (D5.3): a client no-show (`no_show`) bills the floor, and so does an expert who left after
  // the floor before this tick (`abandoned_wait` at the floor is shape `no_show_client`); the two
  // zero shapes (`missed_call`, `abandoned_wait` below the floor) owe nothing, get a `not_billable`
  // marker, and stay silent. BEST-EFFORT AND NON-FATAL, the same posture as `tearDownRoom` below —
  // the meeting is already terminal in Postgres, so a settlement fault must never abort this sweep
  // tick (it would strand every OTHER candidate batched behind it). `actorUserId: null` — the
  // ADR-1030 system-actor exemption, same as `endMeeting` above. The meter sweep's durability
  // backstop (`credit-session-meter-sweep.ts`: the sessionless-meeting pass and the
  // `findPresenceUnsettled` pass) recovers a settlement fault caught here.
  try {
    const result = await settleSessionlessCaseMeeting({
      meetingId: state.meeting.id,
      trigger: 'lifecycle_sweep',
      actorUserId: null,
      now,
    });
    logSessionlessSettlement(state.meeting.id, result);
  } catch (error) {
    logger.error(
      { meetingId: state.meeting.id, error: errorMessage(error) },
      'Presence settlement failed on the lifecycle sweep — the meter sweep durability backstop will retry'
    );
  }

  // ⚠⚠ BAL-473 (§5.2, ARCHITECT AMENDMENT to OD-2) — also hook the six SYSTEM terminal rules,
  // not just the human `end-meeting.ts` path. Two of the six (`idle_end`, `overrun_stop`) are scoped
  // to a meeting that reached `in_progress`, which is the only status under which a recording
  // exists; the other four no-op for free inside `recording-stop` itself (nothing capturing).
  // BEST-EFFORT, the same posture as `tearDownRoom` immediately below: the meeting is already
  // terminal in Postgres, so an enqueue fault must never abort this sweep tick.
  await enqueueRecordingStopBestEffort(state.meeting.id);

  // ⚠ TORN DOWN FROM THE CAS ROW, NEVER `state.meeting` — a room a repair stamped
  // after this tick's batch read is still on the RETURNING row `endMeeting` handed back, and
  // must still be deleted even though this tick decided the meeting on the stale snapshot.
  await tearDownRoom(ended.meeting);
  return decision;
}

/** Best-effort `recording-stop` enqueue — mirrors `tearDownRoom`'s non-fatal posture. */
async function enqueueRecordingStopBestEffort(meetingId: string): Promise<void> {
  try {
    await enqueueRecordingStop({ meetingId });
  } catch (error) {
    logger.error(
      { meetingId, error: errorMessage(error) },
      'recording-stop enqueue failed on the lifecycle sweep — best-effort, the meeting stays ended'
    );
  }
}

/**
 * The per-rule analytics event, beside the universal `meeting_ended`.
 *
 * ⚠ FOUR OF THE SIX RULES HAVE THEIR OWN EVENT AND TWO DO NOT, and that is the ticket's list
 * rather than an omission: `meeting_waiting_abandoned`, `meeting_missed_call`,
 * `meeting_venue_unavailable` and `meeting_overrun_stopped` name failure modes the product needs to count separately — a
 * provisioning failure is a platform incident the product must count separately from any
 * no-show — while the idle end and the no-show are fully described by `meeting_ended.outcome`.
 *
 * ⚠ `endedMeeting` IS THE CAS `RETURNING` ROW, NEVER `state.meeting` — the venue arm's
 * `room_name_stamped` must read whatever `endMeeting` actually returned, not this tick's stale
 * batch snapshot.
 */
function emitRuleAnalytics(
  state: CandidateState,
  decision: MeetingTerminalDecision,
  endedMeeting: Meeting,
  stop: {
    readonly endedAt: Date;
    readonly occupancy: RoomOccupancy;
    readonly closedIntervals: number;
  }
): void {
  if (decision.rule === 'abandoned_wait') {
    trackServer(MEETING_SERVER_EVENTS.MEETING_WAITING_ABANDONED, {
      meeting_id: state.meeting.id,
      expert_present_seconds: Math.round(state.expertPresentMs / 1000),
      // ⚠ THE MEETING ID — no acting human on a system path.
      distinct_id: state.meeting.id,
    });
    return;
  }
  if (decision.rule === 'missed_call') {
    trackServer(MEETING_SERVER_EVENTS.MEETING_MISSED_CALL, {
      meeting_id: state.meeting.id,
      client_joined: state.facts.clientSideEverPresent,
      distinct_id: state.meeting.id,
    });
    return;
  }
  if (decision.rule === 'venue_unavailable') {
    trackServer(MEETING_SERVER_EVENTS.MEETING_VENUE_UNAVAILABLE, {
      meeting_id: endedMeeting.id,
      room_name_stamped: endedMeeting.dailyRoomName !== null,
      distinct_id: endedMeeting.id,
    });
    return;
  }
  if (decision.rule === 'overrun_stop') {
    trackServer(MEETING_SERVER_EVENTS.MEETING_OVERRUN_STOPPED, {
      meeting_id: endedMeeting.id,
      room_occupancy: stop.occupancy,
      minutes_past_scheduled_end: Math.floor(
        (stop.endedAt.getTime() - endedMeeting.scheduledEnd.getTime()) / 60_000
      ),
      open_intervals_closed: stop.closedIntervals,
      distinct_id: endedMeeting.id,
    });
  }
}

/**
 * Delete the Daily room after a SYSTEM termination — the same vendor-side finality the human
 * End path gets. ⚠ BEST-EFFORT AND NON-FATAL: the meeting is already terminal in Postgres and
 * `MEETING_CLOSED_TO_JOIN` already refuses a Balo-side rejoin.
 */
async function tearDownRoom(meeting: Meeting): Promise<void> {
  const roomName = meeting.dailyRoomName;
  if (roomName === null) {
    return;
  }
  // ⚠⚠ THE STAMPED NAME IS CHECKED AGAINST THE DERIVED ONE BEFORE ANYTHING IS DELETED — the
  // same guard `resolveVenue` applies on the JOIN path, and it matters MORE here because this
  // call is DESTRUCTIVE and irreversible. The name is a pure function of `meetings.id`, so
  // there is exactly one correct value; a divergence means the row this job is terminating
  // points at SOMEBODY ELSE'S ROOM, and deleting it would drop a call that is running.
  // Refusing is free — the meeting is already terminal in Postgres and `MEETING_CLOSED_TO_JOIN`
  // already refuses a Balo-side rejoin.
  const expected = dailyRoomNameForMeeting(meeting.id);
  if (roomName !== expected) {
    logger.error(
      { meetingId: meeting.id, expected, stamped: roomName },
      'Stamped Daily room name disagrees with the derived one — REFUSING to delete a room this meeting may not own'
    );
    return;
  }
  try {
    await dailyRoomTeardown.deleteRoom(roomName);
  } catch (error) {
    logger.error(
      { meetingId: meeting.id, roomName, status: 'ended', error: errorMessage(error) },
      'Daily room teardown failed after a system termination'
    );
  }
}

/**
 * PASS 3 — arm the two absence promises.
 *
 * ⚠ ARMED FROM THE SWEEP RATHER THAN FROM BOOKING because the sweep is the only place that
 * reliably observes "the expert never joined" — an event whose whole nature is that nothing
 * happened. `first_wins` makes repeated ticks a cheap `already_pending` no-op, and a
 * `scheduledFor` in the PAST is legal and simply fires on the next tick, so a sweep that first
 * sees a meeting at start+3min still schedules the start+5min alert correctly.
 */
async function armAbsenceReminders(
  state: CandidateState,
  timers: MeetingTimers,
  now: Date
): Promise<void> {
  const { meeting, facts } = state;
  if (now.getTime() < meeting.scheduledStart.getTime()) {
    return;
  }

  if (!facts.expertEverPresent) {
    // ⚠ BAL-581 — the ops alert says "the EXPERT has not joined". With no ready room nobody
    // COULD join: that meeting is the `meeting.unprovisioned` admin alert's, and arming here
    // would page ops to chase an expert who was locked out too. Measured from the venue absence
    // anchor, the SAME instant rule 3 and the waiting phase use — `null` (never ready) or still
    // before the room existed both skip; the next tick re-evaluates from fresh venue facts.
    const anchor = venueAbsenceAnchor(meeting.scheduledStart, meetingVenueReadyAt(meeting));
    if (anchor === null || now.getTime() < anchor.getTime()) {
      return;
    }
    const primary = selectPrimaryMeetingContext(
      await meetingContextsRepository.listByMeeting(meeting.id)
    );
    await scheduleExpertAbsentAlert({
      meetingId: meeting.id,
      scheduledStart: meeting.scheduledStart,
      absenceAnchor: anchor,
      contextType: primary.ok ? primary.context.contextType : 'unknown',
      timers,
    });
    return;
  }

  // The expert is HOLDING the room and no client-side participant has ever arrived.
  if (facts.expertOpen && !facts.clientSideEverPresent) {
    const clockStart = expertClockStart(meeting.scheduledStart, facts.expertFirstJoinedAt);
    const primary = selectPrimaryMeetingContext(
      await meetingContextsRepository.listByMeeting(meeting.id)
    );
    if (clockStart === null || !primary.ok) {
      return;
    }
    // ⚠ THE OWNING COMPANY, resolved from the meeting's OWN primary context — never inferred
    // from whoever happens to be in the room.
    const owner = await resolveMeetingContextOwner(primary.context);
    if (owner === undefined) {
      return;
    }
    await scheduleClientAbsentNudge({
      meetingId: meeting.id,
      companyId: owner.companyId,
      scheduledStart: meeting.scheduledStart,
      clockStart,
      // ⚠ RESOLVED HERE, FROM THE MEETING'S OWN CONTEXT — the expert's AGENCY, or an
      // independent expert's own name (CLAUDE.md's prospective-attribution rule). It used to be
      // hard-coded `null` with a comment claiming the template resolved a fallback; the template
      // resolves NOTHING, so every nudge shipped party-neutral copy. `null` is still a real
      // answer (a `match`-routed discovery names nobody) and still renders "Your expert is in
      // the room" — but it is now the exception rather than the only outcome.
      waitingPartyName: await deliveringPartyName(owner.expertProfileId),
      timers,
    });
  }
}

/**
 * ⚠⚠ THE REPAIR IS NOT COMPLETE UNTIL THE **STATUS** IS REPAIRED TOO.
 *
 * Reconciliation writes `meeting_presence` rows. The status transitions those rows imply —
 * `scheduled → waiting_for_participants`, and `{expert} ∧ {≥1 client-side} → in_progress` — live
 * in `reconcileMeetingStatus`, whose ONLY other caller is the Daily webhook. So before this
 * existed, the WEBHOOK was a single point of failure for every FORWARD transition, and this job
 * — whose entire purpose is repairing dropped webhooks — repaired `left` but not `joined`.
 *
 * The stranding that produced, traced in full because it is not obvious: expert and client both
 * join, both `participant.joined` webhooks drop, the reconciler opens both intervals, and the
 * status stays `scheduled`. Now NO rule can EVER fire — `missedCallApplies` is disarmed by
 * `expertEverPresent`, rules 2 and 4 need a pre-`in_progress` status they no longer match once
 * repaired (and never got), and rule 1 needs `in_progress`. A non-terminal meeting accruing
 * billable presence, with nothing left to terminate it.
 *
 * ⚠ THE ROW IS RE-READ RATHER THAN REUSED. The caller's `meeting` is the batch snapshot, taken
 * before this tick wrote anything; `reconcileMeetingStatus` compare-and-sets against the
 * DATABASE's status, and the terminal rules must then see the status those CAS writes produced.
 * Passing the stale row would make both decisions on a status that is already wrong.
 */
async function repairStatusAndReload(meetingId: string, now: Date): Promise<CandidateState | null> {
  const fresh = await meetingsRepository.findById(meetingId);
  if (fresh === undefined) {
    // Soft-deleted between the batch read and now. Nothing to terminate; the CAS would no-op.
    return null;
  }
  const transition = await reconcileMeetingStatus(fresh, now);
  // ⚠ THE TRANSITION IS THREADED IN RATHER THAN RE-READ. `reconcileMeetingStatus` returns the
  // label it moved the meeting to, so the terminal rules below evaluate against the status that
  // now exists — a third read would be one more instant for it to be wrong at.
  const repaired = transition === null ? fresh : { ...fresh, status: transition };

  return loadCandidateState(repaired, now);
}

/**
 * Best-effort `recording-ensure` enqueue — mirrors the sweep's other best-effort side effects.
 *
 * ⚠ BAL-480 — THE SWEEP'S LEVEL-TRIGGERED SELF-HEAL. Called once per candidate per tick from
 * {@link processCandidate} (never from `repairStatusAndReload`, which BAL-473 used — see
 * `needsRecordingEnsure`'s docblock for the subsumption proof), and subject to
 * `MAX_RECORDING_ENSURES_PER_SWEEP_TICK`. dedupeToken is MONOTONIC per minute, so repeated ticks
 * within one minute collapse to one ensure per meeting — never the bare `meetingId` alone (memory
 * `reference_bullmq_jobid_must_be_per_write_not_per_state`).
 */
async function enqueueRecordingEnsureBestEffort(meetingId: string, now: Date): Promise<void> {
  try {
    await enqueueRecordingEnsure({
      meetingId,
      trigger: 'sweep',
      dedupeToken: `sweep-${Math.floor(now.getTime() / 60_000)}`,
    });
  } catch (error) {
    logger.error(
      { meetingId, error: errorMessage(error) },
      'recording-ensure enqueue failed on the lifecycle sweep — best-effort, next tick retries'
    );
  }
}

/**
 * ⚠⚠ BAL-480 — THE LEVEL TRIGGER'S GATE. BAL-473 armed `recording-ensure` only on the EDGE (the
 * tick that repaired a `→ in_progress` transition), so a meeting that exhausted the ensure's
 * three attempts during a Daily outage, or whose capture slot is held by a segment Daily never
 * acknowledged, stayed silently unrecorded for the rest of the call with nothing on any clock to
 * retry it. This is that clock.
 *
 * ⚠ `state` IS POST-REPAIR. `processCandidate` binds it from `repairStatusAndReload` whenever
 * reconciliation wrote anything, and that function threads the CAS's own transition into the row
 * it returns — so this gate SUBSUMES the edge trigger it replaced rather than sitting beside it.
 * One call site is also what makes the `trigger: 'sweep'` label unambiguous: two enqueues on one
 * tick would collide on the jobId `recording-ensure--<id>--sweep-<bucket>` and BullMQ keeps the
 * FIRST payload, so the label would be silently dropped on exactly the repair ticks.
 *
 * ⚠ THE RECORDINGS READ IS LAST, AND ONLY FOR A LIVE CALL. The two cheap column checks run
 * first, so a `scheduled` / `waiting_for_participants` candidate costs nothing extra per tick.
 *
 * ⚠⚠ `dailyRecordingId !== null` IS THE SUPPRESSION, AND IT MUST NOT BE SIMPLIFIED TO
 * `capturing !== undefined`. A segment whose Daily id never arrived is EXACTLY the stuck slot
 * `handleEnsure`'s reaper exists to release — suppressing it here would make the reaper
 * permanently unreachable from the sweep, which is half of what this ticket ships. Deliberately
 * WIDER than the handler's own stuck predicate: this enqueues for a young unacknowledged row
 * too, and the handler (which owns the threshold) no-ops on it. Widening costs a no-op job;
 * narrowing costs the feature.
 *
 * ⚠⚠ FIX ROUND 1 — THE CAP TERM IS WHAT STOPS THE FAN-OUT BUDGET STARVING. A meeting that has
 * exhausted `MAX_DAILY_FAILURES_PER_MEETING` returns from `handleEnsure`'s step 5.5 WITHOUT
 * inserting, so it never acquires a capturing row, so the two checks above answer `true` for it
 * on EVERY subsequent tick for the rest of its life. `listLifecycleCandidates` orders BY STATUS
 * RANK FIRST (`in_progress`, then `waiting_for_participants`, then `scheduled`, R6F-15), then
 * `asc(scheduledStart), asc(id)` within each rank — stable — so without this term twenty
 * permanently-capped `in_progress` meetings would occupy the whole of
 * `MAX_RECORDING_ENSURES_PER_SWEEP_TICK` forever and no later meeting's self-heal would ever run.
 * That matters precisely POST-OUTAGE, when many meetings are capped at once and the budget must
 * reach the ones still recoverable.
 *
 * ⚠ IT IS A NEW CALL SITE OF AN EXISTING READ, and it is LAST for the same reason the
 * recordings read is: a healthy meeting is already suppressed by the line above, so this costs
 * nothing on the healthy path. It duplicates the handler's own step-5.5 gate deliberately —
 * that one still owns the refusal (the webhook path reaches it without passing here); this one
 * only stops the sweep from spending a scarce per-tick unit on a job guaranteed to no-op.
 */
async function needsRecordingEnsure(state: CandidateState): Promise<boolean> {
  if (state.meeting.status !== 'in_progress' || !state.facts.anyOpen) {
    return false;
  }
  const capturing = await meetingRecordingsRepository.findCapturingForMeeting(state.meeting.id);
  if (capturing !== undefined && capturing.dailyRecordingId !== null) {
    return false;
  }
  const dailyFailures = await meetingRecordingsRepository.countFailedByStage(
    state.meeting.id,
    'daily'
  );
  return dailyFailures < MAX_DAILY_FAILURES_PER_MEETING;
}

/**
 * The stranded arm's reload after a reconciliation: the fresh row and its presence, and NOTHING
 * else. ⚠ DELIBERATELY NOT {@link repairStatusAndReload} — that runs `reconcileMeetingStatus`, whose
 * `markInProgress` and `startBillingIfDue` transitions must never fire on a stranded meeting.
 */
async function reloadStranded(meetingId: string, now: Date): Promise<CandidateState | null> {
  const fresh = await meetingsRepository.findById(meetingId);
  return fresh === undefined ? null : loadCandidateState(fresh, now);
}

/** One candidate, fully processed. ⚠ EVERY CALL SITE WRAPS THIS IN ITS OWN TRY/CATCH. */
async function processCandidate(
  meeting: Meeting,
  mode: SweepMode,
  ctx: SweepContext
): Promise<{ terminated: boolean; closed: number; opened: number; needsRecordingEnsure: boolean }> {
  const { now, timers } = ctx;
  const initial = await loadCandidateState(meeting, now);
  const open = initial.openRows;
  const rosterRead = await resolveRoomRoster(meeting, open, mode, ctx);
  if (mode === 'stranded' && rosterRead.source === 'unknown' && rosterRead.ownBudgetSpent) {
    return { terminated: false, closed: 0, opened: 0, needsRecordingEnsure: false };
  }
  const { closed, opened, verdict } = await reconcileMeeting(initial, open, rosterRead, mode, ctx);
  const read = rosterRead;

  if (read.source !== 'unknown' && closed + opened > 0) {
    // An unknown read never changes anything, so `roster_source` is never `unknown`.
    trackServer(MEETING_SERVER_EVENTS.MEETING_PRESENCE_RECONCILED, {
      meeting_id: meeting.id,
      intervals_closed: closed,
      intervals_opened: opened,
      roster_source: read.source,
      stranded: mode === 'stranded',
      distinct_id: meeting.id,
    });
  }

  if (verdict === 'deferred') {
    // ⚠ A PER-TICK BUDGET OF OUR OWN IS SPENT (close, history read or per-room read): the candidate
    // stays selected and retries next tick, with no terminal rule run on a roster it could not
    // finish reconciling. Closes that already landed are still reported.
    return { terminated: false, closed, opened, needsRecordingEnsure: false };
  }

  // ⚠ RE-READ AFTER RECONCILIATION. The terminal rules branch on `anyOpen`, `lastLeftAt` AND
  // `status`, all of which the pass above may have just changed — evaluating them against the
  // PRE-reconciliation snapshot would delay every idle end and every abandoned wait by a full
  // tick, and would leave a webhook-dropped meeting permanently unterminable (above).
  let state: CandidateState | null = initial;
  if (closed + opened > 0) {
    state =
      mode === 'in_window'
        ? await repairStatusAndReload(meeting.id, now)
        : await reloadStranded(meeting.id, now);
  }
  if (state === null) {
    return { terminated: false, closed, opened, needsRecordingEnsure: false };
  }

  const decision = await terminateIfDue(state, timers, now, roomOccupancy(read), mode);
  if (mode === 'stranded') {
    // ⚠ NOTHING ELSE RUNS FOR A STRAND — no absence reminders (the promise is long past) and no
    // recording-ensure budget (the meeting is not live).
    return { terminated: decision !== null, closed, opened, needsRecordingEnsure: false };
  }
  if (decision !== null) {
    return { terminated: true, closed, opened, needsRecordingEnsure: false };
  }

  await armAbsenceReminders(state, timers, now);
  return {
    terminated: false,
    closed,
    opened,
    needsRecordingEnsure: await needsRecordingEnsure(state),
  };
}

/**
 * `items` rotated to start at index `floor(now / 60s) mod items.length`, wrapping round. The
 * sweep runs every minute, so the offset advances by one per tick and each item is at the head
 * once in any `items.length` consecutive ticks. Pure: the input is not mutated.
 */
export function rotateForTick<T>(items: readonly T[], now: Date): T[] {
  if (items.length === 0) {
    return [];
  }
  const offset = Math.floor(now.getTime() / 60_000) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

export interface MeetingLifecycleSweepResult {
  /** The in-window batch plus the stranded batch. */
  scanned: number;
  /** How many of {@link scanned} came from the stranded batch. */
  stranded: number;
  terminated: number;
  intervalsClosed: number;
  intervalsOpened: number;
  /**
   * BAL-480 — how many `recording-ensure` self-heals this tick **attempted**.
   *
   * ⚠ ATTEMPTED, NOT CONFIRMED, AND THE WORD IS EXACT. The counter is incremented BEFORE
   * `enqueueRecordingEnsureBestEffort`, which swallows its own errors, so a tick with Redis
   * unreachable reports its full budget as spent while nothing reached the queue. That is the
   * deliberate direction: this number's job is to bound the DAILY-facing producer rate
   * (`MAX_RECORDING_ENSURES_PER_SWEEP_TICK`), and an enqueue whose acknowledgement was lost may
   * well have landed — counting it is the conservative side of that bound. Read it as
   * "self-heals this tick tried to schedule", and read `logger.error`'s "recording-ensure
   * enqueue failed" lines for the ones that did not land.
   */
  recordingEnsures: number;
}

/**
 * ⚠ NO SILENT CAPS. A full batch means meetings were DROPPED from this tick, and the sweep is the
 * only layer that can say so — `@balo/db` has no business logging a business event.
 */
function warnIfBatchFilled(candidates: readonly Meeting[], limit: number, message: string): void {
  if (candidates.length === limit) {
    // The in-window batch is ranked by status before age, so the FIRST row is not the oldest —
    // take the minimum.
    const oldest = candidates.reduce<Date | undefined>(
      (min, meeting) =>
        min === undefined || meeting.scheduledStart.getTime() < min.getTime()
          ? meeting.scheduledStart
          : min,
      undefined
    );
    logger.warn({ limit, oldestScheduledStart: oldest?.toISOString() }, message);
  }
}

/** One room of the platform-wide presence read — see {@link readPlatformRoster}. */
interface ListedRoom {
  /** The Daily `userId`s; a participant with no `userId` has none to contribute. */
  readonly userIds: readonly string[];
  /** The RAW participant count, so an id-less participant still makes the room occupied. */
  readonly count: number;
}

/** What one platform-wide presence read yields — see {@link readPlatformRoster}. */
interface PlatformRosterRead {
  readonly rooms: ReadonlyMap<string, ListedRoom>;
  /** `false` ONLY when the vendor call REJECTED. A parseable-but-empty `200` is `true`. */
  readonly rosterAvailable: boolean;
}

/**
 * ⚠ ONE `GET /presence` FOR THE WHOLE PLATFORM, not one per room. The skill names this Daily's
 * recommended "current state" endpoint, and a per-room call per candidate would multiply a 20/s
 * rate-limit tier by the batch size. The per-room fallback ({@link resolveRoomRoster}) exists
 * only for a room this map does not list, and only when this read succeeded.
 *
 * ⚠ A VENDOR FAILURE DEGRADES TO AN UNAVAILABLE ROSTER RATHER THAN ABORTING THE TICK — and an
 * unavailable roster is UNKNOWN, not "the rooms are empty": every candidate's roster is
 * `unknown`, reconciliation is skipped entirely, and a Daily outage can never close every
 * interval on the platform at once. The terminal rules still run.
 * ⚠ AN UNPARSEABLE 200 LANDS HERE TOO: `getAllPresence` validates the body with Zod and THROWS on
 * a shape it does not recognise, precisely so a vendor contract change takes the outage path
 * rather than degrading silently into a confident-looking empty map.
 */
async function readPlatformRoster(presenceReader: PresenceReader): Promise<PlatformRosterRead> {
  try {
    const presence = await presenceReader.getAllPresence();
    return {
      rooms: new Map(
        Object.entries(presence).map(([room, participants]) => [
          room,
          {
            userIds: participants.flatMap((participant) =>
              typeof participant.userId === 'string' ? [participant.userId] : []
            ),
            count: participants.length,
          },
        ])
      ),
      rosterAvailable: true,
    };
  } catch (error) {
    logger.error(
      { error: errorMessage(error) },
      'Daily presence read failed — skipping reconciliation this tick (terminal rules still run)'
    );
    return { rooms: new Map(), rosterAvailable: false };
  }
}

/**
 * The per-tick fan-out budget, carried as ONE MUTABLE ACCUMULATOR on purpose: the increment must
 * stay BEFORE the enqueue (see `MeetingLifecycleSweepResult.recordingEnsures` — the count is
 * ATTEMPTS, and a swallowed enqueue error still spends a unit), and threading the two numbers
 * back through a return value would put that ordering at the mercy of the call site.
 */
interface RecordingEnsureBudget {
  enqueued: number;
  deferred: number;
}

/**
 * Spend one unit of {@link MAX_RECORDING_ENSURES_PER_SWEEP_TICK} on this meeting, or defer it.
 *
 * ⚠ THE COUNTER MOVES FIRST, THEN THE ENQUEUE — `enqueueRecordingEnsureBestEffort` swallows its
 * own errors, so counting afterwards would make the cap unenforceable on the failing path. This
 * is the ordering `recordingEnsures`'s "ATTEMPTED, NOT CONFIRMED" docblock describes.
 */
async function spendRecordingEnsureBudget(
  meetingId: string,
  now: Date,
  budget: RecordingEnsureBudget
): Promise<void> {
  if (budget.enqueued < MAX_RECORDING_ENSURES_PER_SWEEP_TICK) {
    budget.enqueued += 1;
    await enqueueRecordingEnsureBestEffort(meetingId, now);
  } else {
    budget.deferred += 1;
  }
}

/**
 * The stranded read, isolated: a fault here must not take the in-window batch down with it, and
 * the in-window arm has already been read.
 */
async function listStrandedCandidates(floor: Date): Promise<Meeting[]> {
  try {
    return await meetingsRepository.listStrandedLifecycleCandidates({
      scheduledStartBefore: floor,
      limit: MEETING_STRANDED_BATCH_LIMIT,
    });
  } catch (error) {
    logger.error(
      { error: errorMessage(error) },
      'Stranded lifecycle read failed — strands are skipped this tick'
    );
    return [];
  }
}

/** The tick-end warnings for the two reconciler caps — no silent caps. */
function warnIfReconcilerCapsFilled(budget: ReconcileBudget): void {
  if (budget.roomReadsDeferred > 0) {
    logger.warn(
      { limit: MAX_ROOM_PRESENCE_READS_PER_TICK, deferred: budget.roomReadsDeferred },
      'Per-room presence read cap FILLED — the remaining candidates are UNKNOWN this tick and retry on the next'
    );
  }
  if (budget.historyReadsDeferred > 0) {
    logger.warn(
      { limit: MAX_SESSION_HISTORY_READS_PER_TICK, deferred: budget.historyReadsDeferred },
      'Session-history read cap FILLED — the remaining stranded candidates are skipped this tick and retry on the next'
    );
  }
  if (budget.closesDeferred > 0) {
    logger.error(
      { limit: MAX_RECONCILER_CLOSES_PER_TICK, deferred: budget.closesDeferred },
      'Reconciler close cap FILLED — a mass close is itself an anomaly; remaining closes wait for the next tick'
    );
  }
}

/** The sweep body (exported for unit testing without a Redis-backed Worker). */
export async function runMeetingLifecycleSweep(
  now: Date,
  log: (message: string) => void = () => {},
  presenceReader: PresenceReader = dailyPresenceReader
): Promise<MeetingLifecycleSweepResult> {
  const timers = resolveMeetingTimers();
  const floor = new Date(now.getTime() - LIFECYCLE_LOOKBACK_MS);
  const candidates = await meetingsRepository.listLifecycleCandidates({
    statuses: ['scheduled', 'waiting_for_participants', 'in_progress'],
    scheduledStartAfter: floor,
    limit: MEETING_LIFECYCLE_BATCH_LIMIT,
  });
  warnIfBatchFilled(
    candidates,
    MEETING_LIFECYCLE_BATCH_LIMIT,
    'Meeting lifecycle batch FILLED — meetings were dropped from this tick'
  );

  const stranded = await listStrandedCandidates(floor);
  warnIfBatchFilled(
    stranded,
    MEETING_STRANDED_BATCH_LIMIT,
    'Stranded lifecycle batch FILLED — strands were dropped from this tick'
  );

  const result: MeetingLifecycleSweepResult = {
    scanned: candidates.length + stranded.length,
    stranded: stranded.length,
    terminated: 0,
    intervalsClosed: 0,
    intervalsOpened: 0,
    recordingEnsures: 0,
  };
  // ⚠ ONLY WHEN BOTH BATCHES ARE EMPTY — an empty in-window batch must not skip the stranded arm.
  if (result.scanned === 0) {
    return result;
  }

  // The ONE platform-wide presence read, and its outage degrade — see `readPlatformRoster`.
  const ctx: SweepContext = {
    platform: await readPlatformRoster(presenceReader),
    reader: presenceReader,
    budget: {
      closesSpent: 0,
      closesDeferred: 0,
      roomReadsSpent: 0,
      roomReadsDeferred: 0,
      historyReadsSpent: 0,
      historyReadsDeferred: 0,
    },
    timers,
    now,
  };
  const recordingEnsureBudget: RecordingEnsureBudget = { enqueued: 0, deferred: 0 };

  // ⚠ LIVE MEETINGS FIRST: both batches share one budget, so a strand backlog can never starve a
  // live call of its reconciliation.
  //
  // ⚠ THE STRANDED BATCH IS PROCESSED FROM A ROTATING OFFSET (`rotateForTick`). A strand whose
  // room stays UNKNOWN (a persistent per-room 404, a candidate the sweep keeps deferring) spends
  // per-tick budget every tick, and in a fixed oldest-first order the few at the head would
  // starve every younger strand of repair AND termination. Rotating puts each candidate at the
  // head once in any `stranded.length` consecutive ticks, so every strand makes progress.
  // RESIDUAL: more than `MEETING_STRANDED_BATCH_LIMIT` strands that never terminate fill the
  // batch and the younger ones are never selected; the batch-filled warning above and
  // BAL-586's `meeting.stranded` alert cover that.
  const tagged: ReadonlyArray<{ meeting: Meeting; mode: SweepMode }> = [
    ...candidates.map((meeting) => ({ meeting, mode: 'in_window' as const })),
    ...rotateForTick(stranded, now).map((meeting) => ({ meeting, mode: 'stranded' as const })),
  ];
  for (const { meeting, mode } of tagged) {
    try {
      const outcome = await processCandidate(meeting, mode, ctx);
      result.terminated += outcome.terminated ? 1 : 0;
      result.intervalsClosed += outcome.closed;
      result.intervalsOpened += outcome.opened;
      if (outcome.needsRecordingEnsure) {
        await spendRecordingEnsureBudget(meeting.id, now, recordingEnsureBudget);
      }
    } catch (error) {
      const message = errorMessage(error);
      log(`lifecycle sweep failed for meeting ${meeting.id}: ${message}`);
      logger.error({ meetingId: meeting.id, error: message }, 'Meeting lifecycle sweep failed');
    }
  }
  result.recordingEnsures = recordingEnsureBudget.enqueued;

  if (recordingEnsureBudget.deferred > 0) {
    logger.warn(
      { limit: MAX_RECORDING_ENSURES_PER_SWEEP_TICK, deferred: recordingEnsureBudget.deferred },
      "recording-ensure fan-out cap FILLED — self-heal deferred to later ticks to stay inside Daily's ~1/s recording-start tier"
    );
  }
  warnIfReconcilerCapsFilled(ctx.budget);

  logger.info(result, 'Meeting lifecycle sweep complete');
  return result;
}

/** Start the lifecycle sweep worker (concurrency 1 — serialised passes). */
export function startMeetingLifecycleSweepWorker(): Worker {
  return new Worker(
    MEETING_LIFECYCLE_SWEEP_QUEUE,
    async (job: Job) => {
      const result = await runMeetingLifecycleSweep(new Date(), (m) => job.log(m));
      await job.log(
        `meeting lifecycle sweep: ${result.scanned} scanned (${result.stranded} stranded), ${result.terminated} terminated, ${result.intervalsClosed} intervals closed, ${result.intervalsOpened} opened, ${result.recordingEnsures} recording-ensures attempted`
      );
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );
}

/** Register the repeatable per-minute lifecycle sweep. */
export async function registerMeetingLifecycleSweepCron(): Promise<void> {
  const queue = getQueue(MEETING_LIFECYCLE_SWEEP_QUEUE);
  await queue.add(
    'sweep',
    {},
    {
      repeat: { pattern: MEETING_LIFECYCLE_SWEEP_CRON },
      removeOnComplete: true,
    }
  );
}
