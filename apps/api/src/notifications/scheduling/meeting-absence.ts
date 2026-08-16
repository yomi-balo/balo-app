/**
 * BAL-134 (§6) — THE TWO MEETING-ABSENCE PROMISES, AND THEIR FIRE-TIME GUARDS.
 *
 * `SCHEDULED_RECHECKS`' own docblock names "BAL-134 (client/expert absent)" as an outstanding
 * consumer of BAL-420's primitive. This module is that consumer.
 *
 * ── ⚠⚠ CANCELLATION IS NOT THE MECHANISM. THE RECHECK IS. ────────────────────────────────
 *
 * `schedule.ts` makes it a rule: anything CONDITIONAL must register a `recheck`, "because a
 * cancel can always be missed" — and a CLAIMED row is deliberately uncancellable, so there is a
 * window (one claim TTL per stranded attempt) in which no cancel can reach the promise at all.
 * Both guards below therefore RE-READ LIVE STATE at fire time and `markSkipped` with a reason.
 * The presence writer's `cancelScheduledNotification` calls are a cheap optimisation layered on
 * top, and are explicitly best-effort.
 *
 * ⚠ A SKIP IS A NORMAL OUTCOME AND MUST NEVER READ AS A FAILURE. The dispatch tick records it
 * as `skip_reason` + `log.info`, never `last_error`. For the expert alert, the skip is in fact
 * the COMMON case: most experts turn up.
 *
 * ── ⚠ BOTH PROMISES ARE ARMED FROM THE LIFECYCLE SWEEP, NOT FROM BOOKING ────────────────
 *
 * The sweep is the only place that reliably observes *"the expert never joined"* — an event
 * whose whole nature is that nothing happened. `mode: 'first_wins'` makes repeated ticks a
 * cheap no-op (`already_pending`), and a `scheduledFor` in the PAST is legal and simply fires
 * on the next tick — so a sweep that first sees a meeting at start+3min still schedules the
 * start+5min alert correctly rather than losing it.
 *
 * ── ⚠⚠ `correlationId` IS A FRESH uuid PER PROMISE, NEVER THE MEETING ID ─────────────────
 *
 * `publisher.publish` mints `jobId = \`${event}--${correlationId}\`` and `lib/queue.ts` retains
 * completed jobs `{ count: 100 }` on ONE SHARED queue, so a value stable per meeting forever
 * would silently collide with its own earlier send — `queue.add` no-ops while the dispatch tick
 * still marks the row `published`. That is BAL-424's documented defect; it is not repeated
 * here. The guards SPREAD `row.payload`, so the id is stable across a REBUILD of the same
 * promise, which is the other half of the requirement.
 */
import { randomUUID } from 'node:crypto';
import {
  meetingPresenceRepository,
  meetingsRepository,
  partyMembershipsRepository,
  type Meeting,
} from '@balo/db';
import { MEETING_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import { createLogger } from '@balo/shared/logging';
import { summarisePresence, type MeetingTimers, type PresenceFacts } from '@balo/shared/meetings';
import { scheduleNotification } from './schedule.js';
import type { ScheduledRecheck } from './rechecks.js';

const log = createLogger('meeting-absence-scheduling');

/** The registry key for the expert-absent guard. ⚠ Must match `SCHEDULED_RECHECKS`. */
export const MEETING_EXPERT_ABSENT_RECHECK = 'meeting_expert_absent';

/** The registry key for the client-absent guard. */
export const MEETING_CLIENT_ABSENT_RECHECK = 'meeting_client_absent';

/**
 * Dedup + cancel handle for the ops alert.
 *
 * ⚠ THIS EXACT SHAPE IS THE DOCUMENTED EXAMPLE ON `scheduled_notifications.dedupe_key` —
 * BAL-134 is the consumer that docblock was written for.
 */
export function expertAbsentKey(meetingId: string): string {
  return `meeting_expert_absent:${meetingId}`;
}

/** Dedup + cancel handle for the client nudge. */
export function clientAbsentKey(meetingId: string): string {
  return `meeting_client_absent:${meetingId}`;
}

/**
 * ⚠ THE ONE STATE READ BOTH GUARDS SHARE — extracted rather than written twice.
 *
 * The two rechecks are structurally similar by nature (read the meeting, read its presence,
 * decide), and two copies of the load-and-summarise step would be exactly the cross-file
 * duplication SonarCloud's new-code gate flags. It also means the two guards can never disagree
 * about what "the meeting's presence" is.
 */
async function loadAbsenceState(
  meetingId: string
): Promise<{ meeting: Meeting; facts: PresenceFacts } | null> {
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    return null;
  }
  const intervals = await meetingPresenceRepository.listByMeeting(meetingId);
  return {
    meeting,
    facts: summarisePresence(
      intervals.map((row) => ({ party: row.party, joinedAt: row.joinedAt, leftAt: row.leftAt }))
    ),
  };
}

/** `meetings.status` values on which either promise is moot. */
function isTerminal(meeting: Meeting): boolean {
  return meeting.status === 'ended' || meeting.status === 'cancelled';
}

/**
 * ⚠ THE ONE PAYLOAD-FIELD READER BOTH GUARDS SHARE. A row written by an older build, or
 * hand-edited, is SKIPPED — never published blind against a meeting id we could not read.
 */
function meetingIdFrom(payload: Record<string, unknown>): string | null {
  const meetingId = payload.meetingId;
  return typeof meetingId === 'string' && meetingId.length > 0 ? meetingId : null;
}

/**
 * THE EXPERT-ABSENT GUARD. Publishes only if the expert STILL has not joined.
 *
 * ⚠ "EVER JOINED", NOT "IS HERE NOW". An expert who joined and dropped out again has been
 * reached — Balo's operational commitment ("someone will contact them") has already been
 * discharged by their arrival, and paging ops for a network blip is how a load-bearing alert
 * gets muted by its recipients.
 */
export const meetingExpertAbsentRecheck: ScheduledRecheck = async (row) => {
  const meetingId = meetingIdFrom(row.payload);
  if (meetingId === null) {
    return { publish: false, reason: 'malformed_payload' };
  }

  const state = await loadAbsenceState(meetingId);
  if (state === null) {
    return { publish: false, reason: 'meeting_missing' };
  }
  if (isTerminal(state.meeting)) {
    return { publish: false, reason: 'meeting_terminal' };
  }
  if (state.facts.expertEverPresent) {
    return { publish: false, reason: 'expert_joined_before_alert' };
  }

  const minutesPastStart = Number(row.payload.minutesPastStart);
  // ⚠⚠ KEYED ON THE ROW'S OWN ATTEMPT COUNTER, SO ONE PROMISE EMITS AT MOST ONE EVENT.
  //
  // A guard runs BEFORE the publish, and a throw in `publishStoredEvent` / `markPublished`
  // leaves the row `claimed` — so it is re-claimed once the claim TTL lapses and this guard
  // runs AGAIN. Emitting unconditionally therefore reported N alerts for one absence, which
  // contradicts `packages/analytics/src/events/meeting.ts`'s own "one per meeting" statement
  // and would inflate the metric ops sizes its staffing on.
  //
  // `claim` stamps `attempts = attempts + 1` in the same statement that hands us the row, so
  // `attempts <= 1` is exactly "this is the first time anyone has tried to send this promise" —
  // a fact about THIS ROW, not a guess. The residual is stated rather than hidden: if every
  // attempt then fails, one event was emitted for an alert that never went out. That is one
  // false positive, bounded, and the row lands terminal `failed` with a `log.error` beside it —
  // strictly better than one true positive plus N-1 phantoms.
  if (row.attempts <= 1) {
    trackServer(MEETING_SERVER_EVENTS.MEETING_EXPERT_ABSENT_ALERT, {
      meeting_id: meetingId,
      minutes_past_start: Number.isFinite(minutesPastStart) ? minutesPastStart : 0,
      // ⚠ THE MEETING ID — there is no acting human on an alert about an absence.
      distinct_id: meetingId,
    });
  }
  log.warn({ meetingId, minutesPastStart }, 'Expert has not joined — publishing the ops alert');

  // ⚠ SPREAD, NEVER BUILD FRESH — `correlationId` must survive, or the dispatch tick terminally
  // fails the row (`publisher.publish` derives the BullMQ jobId from it).
  return { publish: true, payload: { ...row.payload } };
};

/**
 * THE CLIENT-ABSENT GUARD. Publishes only if the expert is STILL waiting alone.
 *
 * Five ways it skips, and each is a different fact:
 *   · the client turned up — the nudge is moot;
 *   · the EXPERT left — nudging a client to join a room with nobody in it would be worse than
 *     silence, and this is the case cancellation alone cannot cover (nothing about the expert
 *     leaving triggers a cancel);
 *   · the meeting is terminal;
 *   · the payload names no meeting, or no company — `malformed_payload`;
 *   · the company has no live recipient — `no_recipients`.
 *
 * ⚠ THE LAST TWO ARE SKIPS RATHER THAN EMPTY PUBLISHES, AND THAT IS A CORRECTION. Publishing
 * with an empty `recipientUserIds` delivers nothing on either channel while the dispatch tick
 * marks the row `published` — a promise recorded as kept that reached nobody. A `skipped` row
 * carries its reason and is legible; a `published` row that sent nothing is not.
 *
 * ⚠ THE RECIPIENT LIST IS **REBUILT** FROM LIVE MEMBERSHIP, not inherited. A member who left
 * the company between schedule and fire must not be nudged, and one who joined should be.
 */
export const meetingClientAbsentRecheck: ScheduledRecheck = async (row) => {
  const meetingId = meetingIdFrom(row.payload);
  if (meetingId === null) {
    return { publish: false, reason: 'malformed_payload' };
  }

  const state = await loadAbsenceState(meetingId);
  if (state === null) {
    return { publish: false, reason: 'meeting_missing' };
  }
  if (isTerminal(state.meeting)) {
    return { publish: false, reason: 'meeting_terminal' };
  }
  if (state.facts.clientSideEverPresent) {
    return { publish: false, reason: 'client_joined_before_nudge' };
  }
  if (!state.facts.expertOpen) {
    return { publish: false, reason: 'expert_left_before_nudge' };
  }

  // ⚠⚠ A MISSING OR BLANK `companyId` IS A MALFORMED PAYLOAD, EXACTLY LIKE A MISSING
  // `meetingId` — and it used to be treated as neither. The old branch resolved an EMPTY
  // recipient list, returned `publish: true`, logged "publishing the client nudge", and
  // delivered NOTHING while the dispatch tick recorded the row terminal `published`. That is
  // the worst possible shape for a promise: silent, and indistinguishable in the table from a
  // nudge that actually reached somebody. The same function already `markSkipped`s a missing
  // `meetingId`; this is the same class of defect and gets the same treatment.
  const companyId = row.payload.companyId;
  if (typeof companyId !== 'string' || companyId.length === 0) {
    return { publish: false, reason: 'malformed_payload' };
  }

  // ⚠ AND AN EMPTY RESOLVED LIST IS A SKIP FOR THE SAME REASON, NOT A SILENT SEND. Both
  // channels fan out from `recipientUserIds`, so an empty list delivers nothing; recording that
  // as `published` would be a lie in the one table anybody would check.
  const recipientUserIds = await resolveClientRecipients(companyId);
  if (recipientUserIds.length === 0) {
    log.warn(
      { meetingId, companyId },
      'Client nudge has no live recipient on the owning company — skipping rather than recording a delivery that reached nobody'
    );
    return { publish: false, reason: 'no_recipients' };
  }

  log.info(
    { meetingId, recipientCount: recipientUserIds.length },
    'Expert is waiting alone — publishing the client nudge'
  );
  return { publish: true, payload: { ...row.payload, recipientUserIds } };
};

/**
 * WHO ON THE CLIENT SIDE IS NUDGED.
 *
 * ⚠⚠ THE COMPANY'S OWNER/ADMIN MEMBERS, AND THAT NARROWING IS STATED RATHER THAN HIDDEN. The
 * plan says "the client company's live members"; there is no `listMemberUserIds` on
 * `partyMembershipsRepository` today, and `meetings` carries no booker column, so the widest
 * set reachable without adding an un-integration-tested repository method is the
 * `MANAGE_MEMBERS` holders — which is exactly the fan-out `meeting.guest_added` already uses
 * (`resolveSamePartyRecipients`). The consequence, plainly: a plain `member` who booked the
 * consultation is NOT nudged directly, only their owner/admin. **A follow-up ticket should add
 * a live-member listing (with its integration test) and widen this one call.** The role set is
 * derived from `@balo/shared/authz`'s map inside the repository, never from a `role ===` here.
 *
 * ⚠ AND A GUEST OR DELEGATE WITH NO USER ROW IS UNREACHABLE BY CONSTRUCTION — the same
 * structural block that defers SMS (D13). Recorded on the payload's docblock, not discovered.
 */
async function resolveClientRecipients(companyId: string): Promise<string[]> {
  return partyMembershipsRepository.listAdminUserIds('company', companyId);
}

export interface ScheduleExpertAbsentAlertInput {
  readonly meetingId: string;
  readonly scheduledStart: Date;
  readonly contextType: string;
  readonly timers: MeetingTimers;
}

/**
 * ARM the ops salvage alert for `scheduled_start + EXPERT_ABSENT_ALERT_MS`.
 *
 * ⚠ IDEMPOTENT PER MEETING BY THE DEDUPE KEY, which is what lets the per-minute sweep call it
 * on every tick: the second call answers `already_pending` and writes nothing.
 */
export async function scheduleExpertAbsentAlert(
  input: ScheduleExpertAbsentAlertInput
): Promise<void> {
  const fireAt = new Date(input.scheduledStart.getTime() + input.timers.expertAbsentAlertMs);
  const { outcome } = await scheduleNotification(
    'meeting.expert_absent',
    {
      correlationId: randomUUID(),
      meetingId: input.meetingId,
      scheduledStartIso: input.scheduledStart.toISOString(),
      minutesPastStart: Math.round(input.timers.expertAbsentAlertMs / 60_000),
      contextType: input.contextType,
    },
    {
      key: expertAbsentKey(input.meetingId),
      at: fireAt,
      mode: 'first_wins',
      recheck: MEETING_EXPERT_ABSENT_RECHECK,
    }
  );
  log.info({ meetingId: input.meetingId, outcome }, 'Expert-absent alert armed');
}

export interface ScheduleClientAbsentNudgeInput {
  readonly meetingId: string;
  readonly companyId: string;
  readonly scheduledStart: Date;
  /** `max(scheduled_start, expert first join)` — the EXPERT-PRESENT clock start. */
  readonly clockStart: Date;
  readonly waitingPartyName: string | null;
  readonly timers: MeetingTimers;
}

/**
 * ARM the client nudge for `clockStart + CLIENT_ABSENT_NUDGE_MS`.
 *
 * ⚠ ANCHORED ON THE EXPERT-PRESENT CLOCK START, NOT ON `scheduled_start` — an expert who joins
 * at 10:05 has been waiting five minutes at 10:10, not ten. This is the whole reason
 * `CLIENT_ABSENT_NUDGE_MS` is a separate constant from `EXPERT_ABSENT_ALERT_MS` despite sharing
 * a default.
 *
 * ⚠ `companyId` RIDES THE PAYLOAD so the fire-time guard can rebuild the recipient list without
 * re-resolving the meeting's context — which would be a second answer to "who owns this
 * meeting" and could disagree with the one that armed it.
 */
export async function scheduleClientAbsentNudge(
  input: ScheduleClientAbsentNudgeInput
): Promise<void> {
  const fireAt = new Date(input.clockStart.getTime() + input.timers.clientAbsentNudgeMs);
  const { outcome } = await scheduleNotification(
    'meeting.client_absent',
    {
      correlationId: randomUUID(),
      meetingId: input.meetingId,
      // Seeded, then REBUILT by the guard at fire time — see `meetingClientAbsentRecheck`.
      recipientUserIds: [],
      scheduledStartIso: input.scheduledStart.toISOString(),
      waitingPartyName: input.waitingPartyName,
      companyId: input.companyId,
    },
    {
      key: clientAbsentKey(input.meetingId),
      at: fireAt,
      mode: 'first_wins',
      recheck: MEETING_CLIENT_ABSENT_RECHECK,
    }
  );
  log.info({ meetingId: input.meetingId, outcome }, 'Client-absent nudge armed');
}
