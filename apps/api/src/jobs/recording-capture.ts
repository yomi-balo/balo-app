/**
 * BAL-473 (§6.1/§6.2) — `recording-capture`. ONE queue, TWO job names (`ensure` / `stop`) —
 * they share the Daily REST seam, the meeting lookup, and the retry posture, so BullMQ
 * dispatches on `job.name` rather than splitting into two queues.
 *
 * ⚠⚠ EVERY jobId BELOW IS KEYED ON A WRITE, NEVER ON A TARGET STATE — a jobId keyed on the
 * state being reached, rather than the write that reaches it, silently dedupes against a
 * RETAINED COMPLETED job the next time that same state recurs. `getQueue`'s defaults retain
 * completed jobs (`removeOnComplete: { count: 100 }`), so a re-`add` under a state-shaped
 * jobId is SILENTLY DROPPED. `ensure`'s dedupe token is the Daily event id (webhook origin) or
 * a per-minute sweep bucket (sweep origin) — never the bare `meetingId` alone, because
 * "rejoin after empty" is LITERALLY a return to a previous state.
 */
import { Worker, UnrecoverableError, type Job } from 'bullmq';
import {
  meetingsRepository,
  meetingPresenceRepository,
  meetingRecordingsRepository,
  type MeetingRecording,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  trackServer,
  RECORDING_SERVER_EVENTS,
  type RecordingTrigger,
} from '@balo/analytics/server';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import {
  MIN_IDLE_TIMEOUT_SECONDS,
  startRoomRecording,
  stopRoomRecording,
} from '../services/daily/recordings.js';
import { DailyApiError } from '../services/daily/errors.js';

const log = createLogger('recording-capture');

export const RECORDING_CAPTURE_QUEUE = 'recording-capture';

export const ATTEMPTS = 3;
const BACKOFF_DELAY_MS = 5_000;

export interface RecordingEnsureJobData {
  meetingId: string;
  trigger: RecordingTrigger;
}
export interface RecordingStopJobData {
  meetingId: string;
}
export type RecordingCaptureJobData = RecordingEnsureJobData | RecordingStopJobData;

export interface EnqueueRecordingEnsureInput {
  meetingId: string;
  trigger: RecordingTrigger;
  /**
   * The Daily webhook event id (unique forever, never revisited) when the enqueue originates
   * in the webhook, or `` `sweep-${Math.floor(now.getTime() / 60_000)}` `` from the per-minute
   * lifecycle sweep (monotonic, so repeated ticks within one minute collapse to one ensure).
   */
  dedupeToken: string;
}

/**
 * Enqueue `ensure` — "make sure this meeting is (still) being captured". Idempotent by THREE
 * independent layers: (a) the BullMQ jobId collapses repeated enqueues from the same trigger;
 * (b) the row check inside the handler catches a second trigger that arrives after the first
 * committed; (c) the partial-unique `meeting_recording_capturing_idx` is the REAL gate — two
 * ensures that both pass the row check concurrently cannot both insert, and the loser gets a
 * clean `undefined`.
 */
export async function enqueueRecordingEnsure(input: EnqueueRecordingEnsureInput): Promise<void> {
  await getQueue(RECORDING_CAPTURE_QUEUE).add(
    'ensure',
    { meetingId: input.meetingId, trigger: input.trigger } satisfies RecordingEnsureJobData,
    {
      jobId: `recording-ensure--${input.meetingId}--${input.dedupeToken}`,
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
    }
  );
}

export interface EnqueueRecordingStopInput {
  meetingId: string;
}

/**
 * Enqueue `stop`. Per-write, not per-state: `meetingsRepository.endMeeting` is a
 * compare-and-set that returns `undefined` on a second attempt and both call sites (
 * `end-meeting.ts`, `meeting-lifecycle-sweep.ts`) enqueue only on the winning branch — a
 * meeting reaches `ended` EXACTLY ONCE, so `recording-stop--${meetingId}` alone is safe here
 * (unlike `ensure`, there is no "return to a previous state" for a terminal transition).
 */
export async function enqueueRecordingStop(input: EnqueueRecordingStopInput): Promise<void> {
  await getQueue(RECORDING_CAPTURE_QUEUE).add(
    'stop',
    { meetingId: input.meetingId } satisfies RecordingStopJobData,
    {
      jobId: `recording-stop--${input.meetingId}`,
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
    }
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One sweep tick, in ms. ⚠ Restated rather than imported: `meeting-lifecycle-sweep.ts` imports
 * THIS module, so importing `MEETING_LIFECYCLE_SWEEP_CRON` back would close a cycle. Keep the two
 * in step by hand — the sweep's cron is `'* * * * *'`.
 */
const SWEEP_TICK_MS = 60_000;

/**
 * Daily's own shutdown lag AFTER `minIdleTimeOut` elapses — "a further 1–3 minutes", per
 * `.claude/skills/daily-co/SKILL.md`'s `minIdleTimeOut` section. The WORST documented value is
 * taken, deliberately: this number's whole job is to be an upper bound.
 */
const DAILY_RECORDING_SHUTDOWN_LAG_MS = 3 * 60_000;

/**
 * ⚠⚠ FIX ROUND 1 (F8), RE-DERIVED BY BAL-480 — how long a `recording` row may sit with
 * `dailyRecordingId === null` before `handleEnsure`'s step 5 REAPS it. Under BAL-473 this branch
 * only logged; it now writes, so the number stopped being a log-noise threshold and became the
 * boundary of a destructive action. It was 2 minutes, which sat BELOW the vendor floor.
 *
 * ── THE FLOOR, DERIVED ─────────────────────────────────────────────────────────────────────
 *
 * The dangerous misclassification is a LIVE orphan: Daily really did start a recording and only
 * the `recording.started` delivery was lost, so the row looks identical to a dead slot. Reaping
 * that starts a SECOND Daily recording in the same room — two captures, both billing, both
 * ingesting. The escape hatch is Daily stopping the orphan by itself, which takes
 * `MIN_IDLE_TIMEOUT_SECONDS` (60s) + Daily's 1–3 minute shutdown, and the reap can only be
 * observed one sweep tick later, so:
 *
 *   60s (`MIN_IDLE_TIMEOUT_SECONDS`) + 180s (worst shutdown lag) + 60s (one sweep tick) = 5 minutes.
 *
 * ⚠ DERIVED IN CODE, NOT PASTED. Lowering `minIdleTimeOut` without revisiting this would silently
 * re-open the double-capture window; this expression makes that impossible.
 *
 * ── WHAT THE FLOOR DOES *NOT* COVER, STATED HONESTLY ───────────────────────────────────────
 *
 * The escape hatch is an IDLE-ROOM hatch, and step 4 only reaches this branch when the room is
 * OCCUPIED. On a room nobody leaves, a live orphan does not auto-stop at all — it runs until the
 * meeting ends. NO threshold clears that case, which is why the real protection is on the
 * RESOLVER side: `resolveRecordingByRoomFallback` refuses a `ready-to-download` whose `start_ts`
 * predates the meeting's current capturing segment, so an orphan can no longer be mis-attached
 * to a live one. The residual cost of a reap on a continuously-occupied room is therefore ONE
 * orphaned Daily recording that is never ingested and never deleted — an ops/storage cost, not a
 * data-integrity one.
 *
 * ── THE TRADE-OFF, ACCEPTED IN THIS DIRECTION DELIBERATELY ─────────────────────────────────
 *
 * A genuinely dead slot now blocks recording for up to 5 minutes (plus a tick) instead of 2. That
 * is the correct direction: a bounded, observable recording gap is recoverable; a double capture
 * is a billing and data-integrity event. The ticket's own wording — "so a merely-dropped
 * `recording.started` on a live capture is NEVER misclassified" — demands erring long.
 *
 * ⚠ EXPORTED for the tests that pin the reap's `reason` string, which embeds it — the same reason
 * `ATTEMPTS` and `MAX_DAILY_FAILURES_PER_MEETING` are exported.
 */
export const STUCK_CAPTURE_THRESHOLD_MS =
  MIN_IDLE_TIMEOUT_SECONDS * 1000 + DAILY_RECORDING_SHUTDOWN_LAG_MS + SWEEP_TICK_MS;

/**
 * Non-retryable per `rooms.ts`'s Daily 4xx rule, restated: any 4xx OTHER THAN 429 is a config
 * or payload bug, not a transient fault — retrying it changes nothing.
 */
function isUnrecoverableDailyError(error: unknown): boolean {
  return error instanceof DailyApiError && error.status !== 429 && error.status < 500;
}

/**
 * DAILY START FAILURES' SHARE of {@link MAX_DAILY_FAILURES_PER_MEETING} — the headroom that
 * exists BEYOND one exhausted BullMQ retry sequence.
 *
 * TWO. §5.1b stamps a `failed` row on EVERY attempt (in-handler, before the rethrow), so
 * `ATTEMPTS` of the budget is consumed by ONE ~15-second Daily blip; this allowance is what
 * leaves room for two genuine re-arms afterwards, which is enough to distinguish "Daily
 * wobbled" from "this room cannot record". Past that a re-arm can only reproduce the same
 * failure — an ops problem, not a retry problem.
 */
const DAILY_RE_ARM_ALLOWANCE = 2;

/**
 * ⚠⚠ BAL-480 — THE REAPER'S **CONTRIBUTION** TO {@link MAX_DAILY_FAILURES_PER_MEETING}, WHICH IS
 * A SINGLE SHARED BUDGET. A stuck-slot reap writes a `failed` row at stage `daily` (deliberately:
 * a distinct stage would mean extending `RecordingFailureStage`, a second closed analytics union,
 * and desynchronising the runbook's triage table), so reaps spend the SAME counter as Daily start
 * failures rather than one of their own.
 *
 * ⚠⚠ THIS IS AN ADDEND, NOT AN ENFORCED SUB-LIMIT — AND THE DIFFERENCE IS THE WORST CASE. Nothing
 * counts reaps separately: `handleEnsure` reads ONE number (`countFailedByStage(meetingId,
 * 'daily')`) and compares it to ONE ceiling. So on a meeting with NO Daily start failures at all,
 * every unit of the budget is available to reaping and the true bound is
 * `MAX_DAILY_FAILURES_PER_MEETING` reaps — SEVEN, not two. At `STUCK_CAPTURE_THRESHOLD_MS` per
 * reap that is ≈35 minutes, and in the bad-but-possible case (a LIVE capture whose
 * `recording.started` keeps being dropped) each reap orphans a running Daily recording, so the
 * worst case is up to seven concurrent billing recordings on one room. Splitting the counter to
 * enforce two would need a second stage or a second count, which D3 rules out.
 *
 * ⚠ THE BOUND IS THE PLAN'S DELIBERATE CHOICE; THE SIGNAL IS WHAT MAKES IT SURVIVABLE. Every reap
 * emits `recording_failed` with `reason: 'stuck_capture'` (`packages/analytics`), so a meeting
 * reaping repeatedly is visible in PostHog the first time it happens — and repeated reaping means
 * webhook DELIVERY is broken, which is an ops investigation, not something a counter should
 * silently absorb.
 *
 * It is at least naturally rate-limited: a reap needs a capture slot held past
 * `STUCK_CAPTURE_THRESHOLD_MS`, so it can recur at most once per threshold per meeting.
 */
const STUCK_REAP_ALLOWANCE = 2;

/**
 * ⚠⚠ FIX ROUND 2 (R2), RE-DERIVED BY BAL-480 — BOUNDS THE `recording.error` → RE-ARM LOOP.
 * `routes/daily/webhook.ts` re-arms `enqueueRecordingEnsure` UNCONDITIONALLY after every
 * `recording.error`, keyed on the Daily event id — nothing collapses successive iterations. For a
 * persistently-broken room (R1's gap: a pre-deploy room whose `enable_recording` was never
 * reconciled onto it, so every `startRoomRecording` call fails the same way) that loop would
 * otherwise run for the rest of the meeting, each iteration emitting a `failed` row plus
 * `recording_started` + `recording_failed` PostHog events — skewing the §11 metric this analytics
 * family exists to answer. This is where the loop actually stops: `handleEnsure` refuses to arm a
 * FRESH capture once a meeting has failed to start recording this many times at the Daily stage.
 *
 * ⚠⚠ IT IS NEVER A BARE `ATTEMPTS` — SEE {@link DAILY_RE_ARM_ALLOWANCE} AND
 * {@link STUCK_REAP_ALLOWANCE} FOR WHAT EACH ADDEND BUYS. A bare `3` — which this constant was
 * until review caught it — is consumed ENTIRELY by ONE exhausted retry sequence, because §5.1b
 * stamps a `failed` row on EVERY attempt. A single ~15-second Daily blip would then burn all three
 * BullMQ attempts, hit the cap, and DISABLE RECORDING FOR THE REST OF THAT MEETING — the opposite
 * of the intent: the cap exists to stop a loop, not to let one transient outage end a
 * consultation's recording.
 *
 * Deriving it from `ATTEMPTS` keeps the two in step — raising the retry count without raising this
 * would silently re-introduce the same collision.
 *
 * ⚠ ONE COUNTER, THREE CONTRIBUTORS, NO SUB-LIMITS. The addends are how the number was DERIVED,
 * not partitions the code enforces: `countFailedByStage(meetingId, 'daily')` cannot tell a reap
 * from a failed start, so any one contributor can consume the whole budget.
 */
export const MAX_DAILY_FAILURES_PER_MEETING =
  ATTEMPTS + DAILY_RE_ARM_ALLOWANCE + STUCK_REAP_ALLOWANCE;

/**
 * STEPS 1–3 OF {@link handleEnsure}'S LADDER — the gates that read NOTHING but the meeting row —
 * and the venue they resolve. `undefined` means "a gate refused"; each refusal logs its own
 * reason exactly as it did inline, so the observable output of an ensure is unchanged.
 *
 * ⚠ THE ROOM NAME IS THE RETURN VALUE BECAUSE IT IS THE ONLY THING THE LADDER STILL NEEDS. Step
 * 7's `startRoomRecording` is the sole remaining reader of the meeting row, so returning
 * `meeting.dailyRoomName` (already proven non-null by gate 2) keeps the caller from re-narrowing
 * a nullable column — the gate and the value it justifies stay together.
 *
 * ⚠ THE ORDER OF THE FOUR REFUSALS IS BEHAVIOUR, NOT STYLE: terminal before venue before
 * `in_progress`, because each one's log line is what ops reads to tell the cases apart, and a
 * meeting can satisfy more than one at a time (an `ended` meeting with no venue must still
 * report "terminal"). Extracted verbatim — do not reorder or merge.
 */
async function resolveEnsurableRoom(meetingId: string): Promise<string | undefined> {
  // 1. Absent / soft-deleted / terminal → no-op.
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    log.info({ meetingId }, 'recording-ensure: no live meeting — no-op');
    return undefined;
  }
  if (meeting.status === 'ended' || meeting.status === 'cancelled') {
    log.info(
      { meetingId, status: meeting.status },
      'recording-ensure: meeting is terminal — no-op'
    );
    return undefined;
  }

  // 2. No venue (OD-11: daily_room_name is nullable).
  if (meeting.dailyRoomName === null) {
    log.warn({ meetingId }, 'recording-ensure: meeting has no venue — no-op');
    return undefined;
  }

  // 3. D1 — the recording is the billable session's record.
  if (meeting.status !== 'in_progress') {
    log.info(
      { meetingId, status: meeting.status },
      'recording-ensure: meeting is not in_progress — no-op'
    );
    return undefined;
  }

  return meeting.dailyRoomName;
}

/**
 * THE STUCK-SLOT REAP ITSELF — the WRITE and its two outcomes, lifted out of {@link handleEnsure}
 * step 5 unchanged. The CALLER still owns the `stuck` decision and the fall-through, because both
 * are control flow this ticket's correctness rests on; only the write and its logging live here.
 *
 * ⚠ THE TWO WRITES ARE DELIBERATELY NOT TRANSACTIONAL, and `insertCapturing` must NOT gain an
 * `exec` parameter to make them so: its standalone contract is what keeps the Daily REST call out
 * of an open transaction (`meeting-recordings.ts:174-175`). The partial unique index is the real
 * gate for the window between them — a concurrent ensure simply loses with a clean `undefined` at
 * step 6.
 *
 * ⚠⚠ FIX ROUND 1 — `onlyIfUnacknowledged` IS THE TOCTOU TERM, AND IT IS WHAT STOPS A DOUBLE BILL.
 * `stuck` was decided from the row the caller read at step 5, but `markStarted` does NOT move
 * `status`, so the base CAS is blind to a `recording.started` that commits inside that window —
 * and a threshold measured in minutes selects PRECISELY for late deliveries. Without the term,
 * this write would overwrite a live acknowledgement, release its slot, and start a SECOND Daily
 * recording in the same room. With it, the late acknowledgement wins and this reap loses cleanly.
 */
async function reapStuckCaptureSlot(
  meetingId: string,
  capturing: Pick<MeetingRecording, 'id' | 'createdAt'>
): Promise<void> {
  const reaped = await meetingRecordingsRepository.markFailed({
    id: capturing.id,
    stage: 'daily',
    reason: `stuck: no Daily acknowledgement within ${STUCK_CAPTURE_THRESHOLD_MS}ms`,
    at: new Date(),
    onlyIfUnacknowledged: true,
  });
  if (reaped === undefined) {
    // ⚠ THE CAS LOST, IN ONE OF TWO WAYS, AND THE CALLER'S FALL-THROUGH IS CORRECT FOR BOTH:
    //   · a concurrent ensure reaped this slot first (`markFailed` refuses `failed → failed`)
    //     — the slot is now FREE, and the reinsert at step 6 should take it;
    //   · a late `recording.started` stamped a Daily id (`onlyIfUnacknowledged` refused) — the
    //     slot is still HELD by a genuinely live capture, and the reinsert at step 6 loses the
    //     partial unique index with a clean `undefined`, which is exactly the no-op we want.
    // The unique index arbitrates both without this branch having to tell them apart. NO
    // analytics either way: nothing was reaped here, and emitting would double-count.
    log.info(
      { meetingId, recordingId: capturing.id },
      'recording-ensure: the stuck-slot reap lost its CAS — either a concurrent ensure reaped it first, or a late recording.started acknowledged it; falling through and letting the unique index arbitrate'
    );
  } else {
    log.error(
      {
        meetingId,
        recordingId: capturing.id,
        createdAt: capturing.createdAt.toISOString(),
        thresholdMs: STUCK_CAPTURE_THRESHOLD_MS,
      },
      'recording-ensure: REAPED a capture slot Daily never acknowledged — a worker likely died between insert and the Daily call, or a `recording.started` was dropped on a live capture; arming a fresh segment now'
    );
    trackServer(RECORDING_SERVER_EVENTS.RECORDING_FAILED, {
      meeting_id: meetingId,
      stage: 'daily',
      reason: 'stuck_capture',
      distinct_id: meetingId,
    });
  }
}

/**
 * ⚠⚠ §5.1b — STAMP `failed` IMMEDIATELY, IN THE FAILING INVOCATION, BEFORE RETHROWING. Leaving
 * the row at `recording` would hold the meeting's capture slot forever (capture_ended_at stays
 * NULL), so every subsequent ensure — including the failing job's own BullMQ retry — would find a
 * capturing row and no-op, and the meeting would silently never record.
 *
 * ⚠ ALWAYS THROWS (`Promise<never>`) — the stamp is a side effect ON THE WAY OUT, never a
 * swallow. The rethrow is what feeds `attempts`/`backoff`, and `UnrecoverableError` is what stops
 * a 4xx from being retried; both must reach the worker exactly as they did inline.
 */
async function failDailyStart(recordingId: string, error: unknown): Promise<never> {
  const dailyErrorPrefix = error instanceof DailyApiError ? `Daily ${error.status}: ` : '';
  await meetingRecordingsRepository.markFailed({
    id: recordingId,
    stage: 'daily',
    reason: `${dailyErrorPrefix}${errorMessage(error)}`,
    at: new Date(),
  });
  if (isUnrecoverableDailyError(error)) {
    throw new UnrecoverableError(errorMessage(error));
  }
  throw error;
}

/**
 * `ensure` — plan §6.1's ladder, every gate a successful no-op.
 */
async function handleEnsure(job: Job<RecordingEnsureJobData>): Promise<void> {
  const { meetingId, trigger } = job.data;

  // 1–3. The meeting-row gates, in their original order — see `resolveEnsurableRoom`. A refusal
  // has already logged its own reason.
  const dailyRoomName = await resolveEnsurableRoom(meetingId);
  if (dailyRoomName === undefined) {
    return;
  }

  // 4. Never start a recording into an empty room.
  const open = await meetingPresenceRepository.listOpen(meetingId);
  if (open.length === 0) {
    log.info({ meetingId }, 'recording-ensure: room is empty — no-op');
    return;
  }

  // 5. A segment is already capturing.
  const capturing = await meetingRecordingsRepository.findCapturingForMeeting(meetingId);
  if (capturing !== undefined) {
    // ⚠⚠ FIX ROUND 1 (F8), REAPED BY BAL-480 — A WORKER CAN DIE BETWEEN `insertCapturing`
    // COMMITTING AND THE DAILY CALL RETURNING (a deploy, an OOM). The row this branch found may
    // be exactly that: `dailyRecordingId` still NULL, and no Daily event will EVER arrive for
    // it, since Daily was never actually asked to start it. BAL-473 made that OBSERVABLE (a
    // `log.error`) but left the remedy manual, so every later ensure for this meeting no-op'd
    // FOREVER against a segment that never recorded anything. `createdAt` older than the
    // threshold is what distinguishes this from the ordinary (sub-second) window between insert
    // and the Daily call returning.
    const stuck =
      capturing.dailyRecordingId === null &&
      Date.now() - capturing.createdAt.getTime() > STUCK_CAPTURE_THRESHOLD_MS;
    if (!stuck) {
      log.info(
        { meetingId, recordingId: capturing.id },
        'recording-ensure: already_capturing — no-op'
      );
      return;
    }

    // ⚠⚠ RELEASE, THEN FALL THROUGH — NOT `return`. `markFailed` stamps
    // `capture_ended_at = coalesce(capture_ended_at, $at)`, which VACATES
    // `meeting_recording_capturing_idx`, so step 6 below can insert a fresh segment in THIS
    // invocation rather than waiting for another trigger. The write, its CAS outcomes and the
    // TOCTOU term live in `reapStuckCaptureSlot`; the FALL-THROUGH lives here, deliberately.
    await reapStuckCaptureSlot(meetingId, capturing);
    // ⚠ NO `return` — control continues into step 5.5's cap check and step 6's insert.
  }

  // 5.5. FIX ROUND 2 (R2) — a persistently-broken room must not re-arm for the rest of the
  // meeting. Counted BEFORE inserting a fresh capturing row, so the threshold is enforced on
  // the write path itself rather than trusting the webhook's unconditional re-arm to stop.
  const dailyFailures = await meetingRecordingsRepository.countFailedByStage(meetingId, 'daily');
  if (dailyFailures >= MAX_DAILY_FAILURES_PER_MEETING) {
    log.error(
      { meetingId, dailyFailures },
      'recording-ensure: this meeting has failed to start a Daily recording repeatedly — refusing to re-arm; this is an ops problem, not a retry problem'
    );
    return;
  }

  // 6. THE REAL GATE — a concurrent ensure can still win the unique index here.
  const row = await meetingRecordingsRepository.insertCapturing({ meetingId });
  if (row === undefined) {
    log.info({ meetingId }, 'recording-ensure: lost the capturing-slot race — no-op');
    return;
  }

  // 7. The Daily start call.
  try {
    await startRoomRecording(dailyRoomName, { instanceId: row.id });
    trackServer(RECORDING_SERVER_EVENTS.RECORDING_STARTED, {
      meeting_id: meetingId,
      trigger,
      distinct_id: meetingId,
    });
    log.info(
      { meetingId, recordingId: row.id, trigger },
      'recording-ensure: Daily recording started'
    );
  } catch (error) {
    // ⚠⚠ §5.1b — STAMPS `failed` IMMEDIATELY, IN THIS INVOCATION, BEFORE RETHROWING, and it
    // ALWAYS RETHROWS: `failDailyStart` returns `Promise<never>`, so this catch cannot swallow a
    // Daily failure. See its docblock for why the stamp cannot wait for the `failed` handler.
    await failDailyStart(row.id, error);
  }
}

/**
 * `stop` — plan §6.2's ladder. NEVER stamps the row: stopping is a REQUEST, and
 * `ready-to-download` is the only thing that may stamp `capture_ended_at` on a successful
 * capture.
 */
async function handleStop(job: Job<RecordingStopJobData>): Promise<void> {
  const { meetingId } = job.data;

  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined || meeting.dailyRoomName === null) {
    log.info({ meetingId }, 'recording-stop: no live meeting or no venue — success');
    return;
  }

  const capturing = await meetingRecordingsRepository.findCapturingForMeeting(meetingId);
  if (capturing === undefined) {
    log.info({ meetingId }, 'recording-stop: nothing capturing — success');
    return;
  }

  try {
    const outcome = await stopRoomRecording(meeting.dailyRoomName, { instanceId: capturing.id });
    log.info({ meetingId, recordingId: capturing.id, outcome }, 'recording-stop: requested');
  } catch (error) {
    // OD-7's answer for stop is expressed inside `stopRoomRecording` (400/404 → success); a
    // throw here is therefore genuinely retryable (429/5xx/network) or a real 4xx bug.
    if (isUnrecoverableDailyError(error)) {
      throw new UnrecoverableError(errorMessage(error));
    }
    throw error;
  }
}

/**
 * ⚠⚠ BAL-480 FIX ROUND 1 — THE VENDOR-RATE PACER, AND WHY `concurrency` WAS NEVER ONE.
 * `concurrency` bounds jobs IN FLIGHT, not their RATE: five in flight against a ~150–250 ms
 * Daily round trip sustain ≈25 recording starts per second, against
 * `POST /rooms/:name/recordings/start`'s tier of ~1/s (5 per 5s) — the tightest tier Daily has
 * (`services/daily/recordings.ts`, `.claude/skills/daily-co/SKILL.md`).
 *
 * ⚠⚠ OVERRUNNING THAT TIER IS DESTRUCTIVE, NOT MERELY SLOW. A `429` is retryable
 * (`isUnrecoverableDailyError` exempts it), but §5.1b stamps a `failed` row on EVERY attempt
 * before rethrowing — so a rate-limit storm burns `MAX_DAILY_FAILURES_PER_MEETING` and
 * PERMANENTLY DISABLES RECORDING for those meetings. The trigger is the post-outage recovery
 * herd, i.e. exactly the scenario this feature exists to serve.
 *
 * ⚠ THE ARITHMETIC THAT MAKES THIS SAFE (it did NOT hold when the plan rejected a limiter, and
 * the plan's own healthy-path suppression is what changed it):
 *   · PRODUCER — the sweep enqueues at most `MAX_RECORDING_ENSURES_PER_SWEEP_TICK` (20) per
 *     tick on a `'* * * * *'` cron, i.e. ≤20 jobs/min, because `needsRecordingEnsure`
 *     suppresses every healthy meeting. The rejected arithmetic assumed a blanket level trigger
 *     at `MEETING_LIFECYCLE_BATCH_LIMIT` = 200 jobs/min.
 *   · CONSUMER — 1 job/s = 60/min. 60 > 20, so there is no unbounded backlog; the remaining
 *     two thirds absorb the latency-sensitive webhook-origin ensures (which this also paces —
 *     200 simultaneous `participant.joined` deliveries previously meant ~25 starts/s).
 *   · `stop` SHARES THIS QUEUE and is paced too. That is benign: Daily auto-stops a segment on
 *     `minIdleTimeOut` (60s) regardless of whether our stop request has run, and
 *     `stopRoomRecording` maps the resulting 400/404 to `nothing_to_stop`. A delayed stop
 *     costs nothing; it can only arrive after Daily already did the work.
 *   · BullMQ DELAYS, IT DOES NOT FAIL. A rate-limited job is moved back to `wait`
 *     (`Worker.moveLimitedBackToWait`) and retried when the window opens — no attempt is
 *     consumed, so this cannot burn the `attempts: 3` budget.
 *
 * ⚠ RESIDUAL, STATED RATHER THAN HIDDEN: this is head-of-line, not priority-aware. A large
 * simultaneous `stop` burst (many meetings ending in one tick) delays a brand-new meeting's
 * `ensure` behind it at 1/s. Fixing that needs BullMQ job priority, which is a separate ticket
 * — the trade is accepted because the alternative failure mode (a 429 storm permanently
 * disabling recording) is unrecoverable, and this one is a bounded delay.
 */
const DAILY_RECORDING_START_LIMITER = { max: 1, duration: 1000 } as const;

/**
 * Start the `recording-capture` worker — event-triggered, no cron. Dispatches on `job.name`.
 */
export function startRecordingCaptureWorker(): Worker<RecordingCaptureJobData> {
  const worker = new Worker<RecordingCaptureJobData>(
    RECORDING_CAPTURE_QUEUE,
    async (job) => {
      if (job.name === 'ensure') {
        await handleEnsure(job as Job<RecordingEnsureJobData>);
        return;
      }
      if (job.name === 'stop') {
        await handleStop(job as Job<RecordingStopJobData>);
        return;
      }
      // Defensive: no other job name is ever enqueued onto this queue.
      log.error(
        { jobName: job.name },
        'recording-capture: unknown job name — acking with no effect'
      );
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
      limiter: DAILY_RECORDING_START_LIMITER,
    }
  );

  worker.on('failed', (job, err) => {
    if (!job) {
      return;
    }
    const attempts = job.opts.attempts ?? ATTEMPTS;
    const terminal = err instanceof UnrecoverableError || job.attemptsMade >= attempts;
    if (!terminal) {
      return;
    }
    log.error(
      { jobName: job.name, meetingId: job.data.meetingId, error: errorMessage(err) },
      `recording-capture: ${job.name} exhausted retries`
    );
    if (job.name === 'ensure') {
      // ⚠ DOES NOT STAMP THE ROW — §5.1b already stamped it inside the handler, before this
      // point, so the retry could re-enter with a fresh row.
      trackServer(RECORDING_SERVER_EVENTS.RECORDING_FAILED, {
        meeting_id: job.data.meetingId,
        stage: 'daily',
        reason: 'daily_api_error',
        distinct_id: job.data.meetingId,
      });
    }
    // `stop`'s terminal failure emits no analytics (the ticket defines none) and stamps
    // nothing — the recording still completes via Daily's own finalization.
  });

  return worker;
}
