import { Worker, type Job } from 'bullmq';
import {
  db,
  meetingContextsRepository,
  meetingPresenceRepository,
  meetingRecordingsRepository,
  meetingsRepository,
  resolveMeetingContextOwner,
  type Meeting,
} from '@balo/db';
import { MEETING_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import { createLogger } from '@balo/shared/logging';
import {
  computeMeetingClocks,
  dailyParticipantIdFor,
  dailyRoomNameForMeeting,
  expertClockStart,
  resolveTerminalRule,
  selectPrimaryMeetingContext,
  summarisePresence,
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
import { settleMeetingIfBillable } from '../services/credit-session/settle-from-presence.js';
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
 *      open one for a vendor participant Balo has none for (a dropped `participant.joined`).
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
 * ⚠ A LOOKBACK FLOOR, NOT A WINDOW. Anything older than this is a data-repair problem, not a
 * live meeting, and scanning it every minute forever would grow without bound.
 */
const LIFECYCLE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** ⚠ THE CALLER MUST WARN WHEN THIS FILLS — the no-silent-caps rule. It does, below. */
export const MEETING_LIFECYCLE_BATCH_LIMIT = 200;

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
}

async function loadCandidateState(meeting: Meeting, now: Date): Promise<CandidateState> {
  const rows = await meetingPresenceRepository.listByMeeting(meeting.id);
  const intervals = rows.map((row) => ({
    party: row.party,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt,
  }));
  return {
    meeting,
    facts: summarisePresence(intervals),
    // ⚠ REPORTING ONLY — no terminal rule reads a DURATION. `computeMeetingClocks` is the one
    // definition of the two spans, and this number reaches the `meeting_waiting_abandoned` event
    // and the "Terminal rule fired" log line, never a decision. Rule 4 once compared it against
    // the no-show floor; that comparison was the C2 stranding hole (`lifecycle.ts`).
    expertPresentMs: computeMeetingClocks(intervals, now).expertPresentMs,
  };
}

/**
 * PASS 1 — reconcile ONE meeting against the vendor's roster.
 *
 * ⚠ THE VENDOR ROSTER IS USED ONLY TO DECIDE **WHETHER** AN INTERVAL SHOULD BE OPEN OR CLOSED —
 * never to decide WHOSE it is. `party` is still derived server-side by `resolvePresenceEffect`
 * from Balo's own tables, because it is a billing input (see the presence writer's docblock).
 */
async function reconcileMeeting(
  state: CandidateState,
  roster: readonly string[] | null,
  platformRosterEmpty: boolean,
  now: Date
): Promise<{ closed: number; opened: number }> {
  const { meeting } = state;
  // ⚠⚠ `null` MEANS **UNKNOWN**, NOT "THE ROOM IS EMPTY", AND CONFLATING THE TWO WOULD BE THE
  // WORST BUG IN THIS FILE. A Daily outage, a `429`, or an un-provisioned meeting all yield no
  // roster — and treating that as an empty room would close EVERY open interval on EVERY live
  // meeting on the platform in one tick, truncating every billable span at once. Reconciliation
  // is SKIPPED instead; the terminal rules still run, and the next tick with a real roster
  // repairs whatever drifted.
  if (roster === null) {
    return { closed: 0, opened: 0 };
  }
  const vendorIds = new Set(roster);
  const open = await meetingPresenceRepository.listOpen(meeting.id);

  // ⚠⚠ THE SANITY GATE — the second half of the same hazard, and the half a THROWN error does
  // not cover. `rosterAvailable` only catches a vendor call that REJECTED. A `200` whose body
  // this platform cannot interpret the way it expects yields a well-formed EMPTY map with
  // `rosterAvailable === true`, and then every candidate resolves to `[]` = "confirmed empty":
  // every open interval on the platform closes in one tick, ~5 minutes later `idleEndApplies`
  // ends every `in_progress` meeting, and `tearDownRoom` DELETES DAILY ROOMS OUT FROM UNDER
  // PEOPLE WHO ARE STILL TALKING. Balo holding open intervals while the vendor claims NOBODY is
  // in ANY room on the whole platform is not a state worth acting on — it is evidence the read
  // is wrong. Treat it as UNKNOWN, exactly as the outage path does.
  //
  // ⚠ THE COST OF THE GATE, STATED HONESTLY RATHER THAN GLOSSED. It fires only when the vendor
  // reports ZERO ROOMS platform-wide — not when a room is present and confirmed empty, which is
  // the ordinary "everyone left" answer and still reconciles normally. So the one thing it
  // genuinely defers is repairing a stale interval while NOBODY IS ON ANY BALO CALL AT ALL, and
  // that state lifts the moment any room anywhere has an occupant: the next tick reconciles
  // normally and the stale interval closes then. A deferred repair on a fully idle platform is
  // strictly better than a mass teardown of live rooms on a misread body.
  if (platformRosterEmpty && open.length > 0) {
    logger.warn(
      { meetingId: meeting.id, openIntervals: open.length },
      'Daily reported NO participants in ANY room platform-wide while Balo holds open intervals — treating the roster as UNKNOWN and skipping reconciliation'
    );
    return { closed: 0, opened: 0 };
  }

  let closed = 0;
  for (const row of open) {
    const claim = claimFor(row.userId, row.meetingGuestId);
    // ⚠ AN INTERVAL WITH NO IDENTITY CANNOT BE RECONCILED — there is nothing to match against
    // the roster. It is `observer` by construction (the unmappable-participant path), so it
    // bills nothing either way, and closing it on a guess would be worse than leaving it.
    if (claim === null || vendorIds.has(claim)) {
      continue;
    }
    // ⚠ BUILT FROM THE STORED ROW, NOT RE-DERIVED. `close` matches on IDENTITY only, so the
    // party derivation a full `resolvePresenceEffect` would run — the participation gate plus a
    // delivery-identity read, per interval, per candidate, every minute — buys the write
    // nothing and could only introduce disagreement. See `closePresenceEffectForRow`.
    const effect = closePresenceEffectForRow(meeting, row, now);
    const outcome = await applyPresenceEffect(db, effect);
    if (outcome === 'closed') {
      closed += 1;
      // ⚠ EACH ONE IS A DROPPED `participant.left` WEBHOOK. The RATE is the health signal for
      // the whole presence model — this is the only place it is visible.
      logger.warn(
        { meetingId: meeting.id, participantId: claim, openedAt: row.joinedAt.toISOString() },
        'Reconciler closed an interval the vendor roster does not confirm — a dropped webhook'
      );
    }
  }

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

  return { closed, opened };
}

/**
 * Rebuild the Daily `user_id` CLAIM for one stored interval, so it can be compared against the
 * vendor roster. ⚠ `null` for an interval with no identity — see {@link reconcileMeeting}.
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

/** PASS 2 — evaluate the four terminal rules and, on a match, end the meeting. */
async function terminateIfDue(
  state: CandidateState,
  timers: MeetingTimers,
  now: Date
): Promise<MeetingTerminalDecision | null> {
  const decision = resolveTerminalRule({
    status: state.meeting.status,
    scheduledStart: state.meeting.scheduledStart,
    presence: state.facts,
    timers,
    now,
  });
  if (decision === null) {
    return null;
  }

  const ended = await meetingsRepository.endMeeting({
    id: state.meeting.id,
    outcome: decision.outcome,
    // ⚠ ALL FOUR SYSTEM RULES REPORT `system_idle` — `ended_by` answers "person or system?", and
    // WHICH rule fired is answered by `outcome` plus the `meeting.ended` audit row. A label per
    // rule would duplicate `outcome` and then be free to disagree with it.
    endedBy: 'system_idle',
    endedAt: now,
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
      outcome: decision.outcome,
      endedBy: 'system_idle',
      expertPresentMs: state.expertPresentMs,
    },
    'Terminal rule fired'
  );

  emitRuleAnalytics(state, decision);
  await emitMeetingEnded({
    meeting: ended.meeting,
    endedBy: 'system_idle',
    actorUserId: null,
    now,
  });

  // ⚠⚠ BAL-412 (ADR-1044 §7) — PRESENCE SETTLEMENT. BAL-466 wires it: `joinMeetingAsMember`
  // opens a `duration_source='presence'` session when the first CLIENT-side member is admitted
  // to a `case` meeting. Still returns `no_meeting` for every non-`case` meeting and for a Case
  // whose client never joined. BEST-EFFORT AND NON-FATAL, the same posture as `tearDownRoom`
  // below — the meeting is already terminal in Postgres, so a settlement fault must never abort
  // this sweep tick (it would strand every OTHER candidate batched behind it). `actorUserId:
  // null` — the ADR-1030 system-actor exemption, same as `endMeeting` above. The meter sweep's
  // durability backstop (§4.3, `credit-session-meter-sweep.ts`'s `findPresenceUnsettled` pass)
  // recovers a settlement fault caught here.
  try {
    const outcome = await settleMeetingIfBillable({
      meetingId: state.meeting.id,
      actorUserId: null,
      now,
    });
    if (!outcome.ok && outcome.code !== 'no_meeting') {
      logger.warn(
        { meetingId: state.meeting.id, code: outcome.code },
        'Presence settlement declined on the lifecycle sweep — the meter sweep durability backstop will retry'
      );
    }
  } catch (error) {
    logger.error(
      { meetingId: state.meeting.id, error: errorMessage(error) },
      'Presence settlement failed on the lifecycle sweep — the meter sweep durability backstop will retry'
    );
  }

  // ⚠⚠ BAL-473 (§5.2, ARCHITECT AMENDMENT to OD-2) — also hook the four SYSTEM terminal rules,
  // not just the human `end-meeting.ts` path. Exactly one of the four (`idle_end`) is scoped
  // to a meeting that reached `in_progress`, which is the only status under which a recording
  // exists; the other three no-op for free inside `recording-stop` itself (nothing capturing).
  // BEST-EFFORT, the same posture as `tearDownRoom` immediately below: the meeting is already
  // terminal in Postgres, so an enqueue fault must never abort this sweep tick.
  await enqueueRecordingStopBestEffort(state.meeting.id);

  await tearDownRoom(state.meeting);
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
 * ⚠ TWO OF THE FOUR RULES HAVE THEIR OWN EVENT AND TWO DO NOT, and that is the ticket's list
 * rather than an omission: `meeting_waiting_abandoned` and `meeting_missed_call` name failure
 * modes the product needs to count separately, while the idle end and the no-show are fully
 * described by `meeting_ended.outcome`.
 */
function emitRuleAnalytics(state: CandidateState, decision: MeetingTerminalDecision): void {
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
    const primary = selectPrimaryMeetingContext(
      await meetingContextsRepository.listByMeeting(meeting.id)
    );
    await scheduleExpertAbsentAlert({
      meetingId: meeting.id,
      scheduledStart: meeting.scheduledStart,
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
 * on EVERY subsequent tick for the rest of its life. `listLifecycleCandidates` orders
 * `asc(scheduledStart), asc(id)` — stable — so without this term twenty permanently-capped
 * meetings would occupy the whole of `MAX_RECORDING_ENSURES_PER_SWEEP_TICK` forever and no later
 * meeting's self-heal would ever run. That matters precisely POST-OUTAGE, when many meetings are
 * capped at once and the budget must reach the ones still recoverable.
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

/** One candidate, fully processed. ⚠ EVERY CALL SITE WRAPS THIS IN ITS OWN TRY/CATCH. */
async function processCandidate(
  meeting: Meeting,
  roster: readonly string[] | null,
  platformRosterEmpty: boolean,
  timers: MeetingTimers,
  now: Date
): Promise<{ terminated: boolean; closed: number; opened: number; needsRecordingEnsure: boolean }> {
  const initial = await loadCandidateState(meeting, now);
  const { closed, opened } = await reconcileMeeting(initial, roster, platformRosterEmpty, now);

  // ⚠ RE-READ AFTER RECONCILIATION. The terminal rules branch on `anyOpen`, `lastLeftAt` AND
  // `status`, all of which the pass above may have just changed — evaluating them against the
  // PRE-reconciliation snapshot would delay every idle end and every abandoned wait by a full
  // tick, and would leave a webhook-dropped meeting permanently unterminable (above).
  const state = closed + opened > 0 ? await repairStatusAndReload(meeting.id, now) : initial;
  if (state === null) {
    return { terminated: false, closed, opened, needsRecordingEnsure: false };
  }

  const decision = await terminateIfDue(state, timers, now);
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

export interface MeetingLifecycleSweepResult {
  scanned: number;
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
function warnIfBatchFilled(candidates: readonly Meeting[]): void {
  if (candidates.length === MEETING_LIFECYCLE_BATCH_LIMIT) {
    const [oldest] = candidates;
    logger.warn(
      {
        limit: MEETING_LIFECYCLE_BATCH_LIMIT,
        oldestScheduledStart: oldest?.scheduledStart.toISOString(),
      },
      'Meeting lifecycle batch FILLED — meetings were dropped from this tick'
    );
  }
}

/** What one platform-wide presence read yields — see {@link readPlatformRoster}. */
interface PlatformRosterRead {
  readonly roster: Record<string, string[]>;
  /** `false` ONLY when the vendor call REJECTED. A parseable-but-empty `200` is `true`. */
  readonly rosterAvailable: boolean;
}

/**
 * ⚠ ONE `GET /presence` FOR THE WHOLE PLATFORM, not one per room. The skill names this Daily's
 * recommended "current state" endpoint, and a per-room call per candidate would multiply a 20/s
 * rate-limit tier by the batch size.
 *
 * ⚠ A VENDOR FAILURE DEGRADES TO AN EMPTY ROSTER RATHER THAN ABORTING THE TICK — and the empty
 * roster is treated as UNKNOWN, not as "the rooms are empty": `reconcileMeeting` is skipped
 * entirely so a Daily outage can never close every interval on the platform at once.
 * ⚠ AN UNPARSEABLE 200 LANDS HERE TOO: `getAllPresence` validates the body with Zod and THROWS on
 * a shape it does not recognise, precisely so a vendor contract change takes the outage path
 * rather than degrading silently into a confident-looking empty map.
 */
async function readPlatformRoster(presenceReader: PresenceReader): Promise<PlatformRosterRead> {
  let roster: Record<string, string[]> = {};
  try {
    const presence = await presenceReader.getAllPresence();
    roster = Object.fromEntries(
      Object.entries(presence).map(([room, participants]) => [
        room,
        participants.flatMap((participant) =>
          typeof participant.userId === 'string' ? [participant.userId] : []
        ),
      ])
    );
  } catch (error) {
    logger.error(
      { error: errorMessage(error) },
      'Daily presence read failed — skipping reconciliation this tick (terminal rules still run)'
    );
    return { roster, rosterAvailable: false };
  }
  return { roster, rosterAvailable: true };
}

/**
 * ⚠ `null` WHEN THE ROSTER IS UNKNOWN — a vendor failure, or an un-provisioned meeting with no
 * room name. Never `[]`, which would mean "confirmed empty". See {@link reconcileMeeting}.
 */
function roomRosterFor(
  meeting: Meeting,
  roster: Record<string, string[]>,
  rosterAvailable: boolean
): readonly string[] | null {
  return rosterAvailable && meeting.dailyRoomName !== null
    ? (roster[meeting.dailyRoomName] ?? [])
    : null;
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

/** The sweep body (exported for unit testing without a Redis-backed Worker). */
export async function runMeetingLifecycleSweep(
  now: Date,
  log: (message: string) => void = () => {},
  presenceReader: PresenceReader = dailyPresenceReader
): Promise<MeetingLifecycleSweepResult> {
  const timers = resolveMeetingTimers();
  const candidates = await meetingsRepository.listLifecycleCandidates({
    statuses: ['scheduled', 'waiting_for_participants', 'in_progress'],
    scheduledStartAfter: new Date(now.getTime() - LIFECYCLE_LOOKBACK_MS),
    limit: MEETING_LIFECYCLE_BATCH_LIMIT,
  });

  warnIfBatchFilled(candidates);

  const result: MeetingLifecycleSweepResult = {
    scanned: candidates.length,
    terminated: 0,
    intervalsClosed: 0,
    intervalsOpened: 0,
    recordingEnsures: 0,
  };
  if (candidates.length === 0) {
    return result;
  }

  // The ONE platform-wide presence read, and its outage degrade — see `readPlatformRoster`.
  const { roster, rosterAvailable } = await readPlatformRoster(presenceReader);

  // ⚠ "THE VENDOR SAYS NOBODY IS IN ANY ROOM ON THE WHOLE PLATFORM." Legal, and on an idle
  // platform even true — but it is ALSO what an unexpected-but-parseable body looks like, and
  // acting on it closes every interval everywhere at once. `reconcileMeeting` treats it as
  // UNKNOWN for any candidate that actually holds open intervals; see the gate there.
  const platformRosterEmpty = rosterAvailable && Object.keys(roster).length === 0;

  const recordingEnsureBudget: RecordingEnsureBudget = { enqueued: 0, deferred: 0 };

  for (const meeting of candidates) {
    try {
      const roomRoster = roomRosterFor(meeting, roster, rosterAvailable);
      const outcome = await processCandidate(meeting, roomRoster, platformRosterEmpty, timers, now);
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

  logger.info(result, 'Meeting lifecycle sweep complete');
  return result;
}

/** Start the lifecycle sweep worker (concurrency 1 — serialised passes). */
export function startMeetingLifecycleSweepWorker(): Worker {
  return new Worker(
    MEETING_LIFECYCLE_SWEEP_QUEUE,
    async (job: Job) => {
      const result = await runMeetingLifecycleSweep(new Date(), (m) => job.log(m));
      job.log(
        `meeting lifecycle sweep: ${result.scanned} scanned, ${result.terminated} terminated, ${result.intervalsClosed} intervals closed, ${result.intervalsOpened} opened, ${result.recordingEnsures} recording-ensures attempted`
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
