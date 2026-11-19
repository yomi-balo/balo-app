/**
 * BAL-654 (copy sheet §6) — THE "SOMEONE IS WAITING FOR YOU" SMS, AND ITS FIRE-TIME GUARD.
 *
 * When one side of a booked consultation has been alone about a minute past
 * `max(scheduled_start, that side's first join)`, the ABSENT party is texted once. The lifecycle
 * sweep arms the promise; {@link meetingWaitingSmsRecheck} re-reads live state at fire time,
 * resolves the single recipient and gates eligibility; the presence writer cancels it as an
 * optimisation once both sides are present. The recheck is the authority, not the cancel — the
 * same rule as `meeting-absence.ts`, and for the same reason (a claimed row is uncancellable).
 *
 * ── ⚠ ONCE PER CONSULTATION — THE KEY'S HISTORY, NOT THE KEY ───────────────────────────────
 * The dedupe key folds only onto PENDING rows, so a fired promise would be armed again on the
 * next sweep tick. {@link scheduleWaitingPartySms} and the recheck therefore read the key's
 * history through `scheduledKeyDecided`; a skip is re-armable only for the reasons in
 * {@link REARMABLE_WAITING_SMS_SKIP_REASONS}. `active_in_app` and `outside_hours` are FINAL for now
 * (one decision per consultation); revisit with BAL-653's real presence.
 *
 * ── ⚠ ELIGIBILITY IS THE RING SMS'S, MINUS THE DAILY CAP ────────────────────────────────────
 * Only `smsEligibility` and `isInsideSmsHours` are reused from `call-now/sms-reach.ts`. The
 * per-pair daily cap is NOT consumed: one-per-meeting is the dedupe key's job. The presence
 * answer is the same stub seam BAL-652 uses (`offlineCalleePresence`); real presence is BAL-653.
 *
 * ── ⚠ RECIPIENTS ARE ONE PERSON, NEVER A ROLE ────────────────────────────────────────────────
 * Client direction → the meeting's booker only, and only while they still hold `participate`.
 * Expert direction → the delivering expert's own user, never their agency's owners or admins.
 * Never a guest, delegate or colleague.
 *
 * ── ⚠ THE PUBLISHED PAYLOAD IS BUILT FIELD BY FIELD, NEVER SPREAD ───────────────────────────
 * A stray `userId` on the stored row would reach the dispatcher's `self` resolution, so the guard
 * publishes exactly the {@link MeetingWaitingSmsPayload} keys. `correlationId` is a FRESH uuid PER
 * PROMISE (see `meeting-absence.ts`) and is carried over from the row. The owning company and
 * expert are re-resolved from the meeting's own primary context at fire time and COMPARED with the
 * payload (never substituted): a disagreement skips `owner_mismatch`.
 */
import { randomUUID } from 'node:crypto';
import {
  clientPartyRecipientsRepository,
  companiesRepository,
  meetingRingsRepository,
  usersRepository,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { expertClockStart, type PresenceFacts } from '@balo/shared/meetings';
import { WAITING_PARTY_SMS_DELAY_MS } from '../../config/meeting-timers.js';
import {
  deliveringContextOwnerForMeeting,
  deliveringExpertUserId,
} from '../../services/meetings/delivering-party.js';
import { meetingOrigin } from '../../services/call-now/meeting-origin.js';
import { offlineCalleePresence } from '../../services/call-now/callee-presence.js';
import { isInsideSmsHours, smsEligibility } from '../../services/call-now/sms-reach.js';
import type { MeetingWaitingSmsPayload } from '../events.js';
import {
  isCaseNoLongerActive,
  isTerminal,
  loadAbsenceState,
  meetingIdFrom,
} from './meeting-absence.js';
import type { ScheduledRecheck } from './rechecks.js';
import { scheduleNotification } from './schedule.js';
import { isScheduledKeyDecided } from './scheduled-key-decided.js';

const log = createLogger('meeting-waiting-sms-scheduling');

/** The registry key for the waiting-party guard. ⚠ Must match `SCHEDULED_RECHECKS`. */
export const MEETING_WAITING_SMS_RECHECK = 'meeting_waiting_sms';

/** Dedup + cancel handle: one promise per meeting, shared by both directions. */
export function meetingWaitingSmsKey(meetingId: string): string {
  return `meeting_waiting_sms:${meetingId}`;
}

/** `to_client`: the expert is waiting. `to_expert`: the client side is waiting. */
export type WaitingSmsDirection = 'to_client' | 'to_expert';

export const WAITING_SMS_EVENT_BY_DIRECTION = {
  to_client: 'meeting.waiting_for_client',
  to_expert: 'meeting.waiting_for_expert',
} as const satisfies Record<WaitingSmsDirection, string>;

/**
 * Every skip the waiting-party guard records besides the ones `smsEligibility` answers — defined
 * ONCE, so the re-armable list and the guard's own returns are typed from the same union.
 */
export const WAITING_SMS_SKIP_REASONS = [
  'malformed_payload',
  'meeting_missing',
  'meeting_terminal',
  'call_now',
  'call_ringing',
  'already_decided',
  'owner_mismatch',
  'owner_unresolved',
  'absent_party_joined',
  'waiter_left',
  'case_closed',
  'no_booker',
  'no_expert',
] as const;
export type WaitingSmsSkipReason =
  | (typeof WAITING_SMS_SKIP_REASONS)[number]
  | Extract<ReturnType<typeof smsEligibility>, { eligible: false }>['reason'];

/**
 * The skips after which the promise may be armed again: the waiter walked out before the fire
 * time (and may return), a live ring has since ended (it had its own SMS, which may not have
 * reached anyone), or a sibling's decision has since been cleared. Every other skip is final.
 */
export const REARMABLE_WAITING_SMS_SKIP_REASONS: readonly WaitingSmsSkipReason[] = [
  'waiter_left',
  'call_ringing',
  'already_decided',
];

/**
 * ⚠ THE ONE TRIGGER DEFINITION — the arm site and the recheck both ask it, so they cannot
 * disagree about who is waiting.
 *
 * The two cases are disjoint: the first needs an expert to have been present, the second needs
 * none. A client-side OCCUPANT of any kind counts (a waiting colleague or guest is still someone
 * waiting for the expert); an `observer` never does, because `clientSideOpen` excludes them.
 */
export function waitingSmsDirection(
  facts: Pick<
    PresenceFacts,
    'expertOpen' | 'expertEverPresent' | 'clientSideOpen' | 'clientSideEverPresent'
  >
): WaitingSmsDirection | null {
  if (facts.expertOpen && !facts.clientSideEverPresent) {
    return 'to_client';
  }
  if (facts.clientSideOpen && !facts.expertEverPresent) {
    return 'to_expert';
  }
  return null;
}

/**
 * Has this meeting's waiting-party SMS already been decided? Check-only, so the sweep can ask it
 * before any other read: a fired SMS then costs one read per tick. `excludeId` is a recheck's own row.
 */
export function isWaitingSmsDecided(meetingId: string, excludeId?: string): Promise<boolean> {
  return isScheduledKeyDecided(
    meetingWaitingSmsKey(meetingId),
    REARMABLE_WAITING_SMS_SKIP_REASONS,
    excludeId
  );
}

export interface ScheduleWaitingPartySmsInput {
  readonly meetingId: string;
  readonly scheduledStart: Date;
  readonly direction: WaitingSmsDirection;
  /** The waiting side's first join — `expertFirstJoinedAt` or `clientSideFirstJoinedAt`. */
  readonly waiterFirstJoinedAt: Date | null;
  readonly companyId: string;
  readonly expertProfileId: string | null;
}

/**
 * ARM the promise for `max(scheduled_start, waiter first join) + WAITING_PARTY_SMS_DELAY_MS`.
 *
 * ⚠ A fire time in the PAST is legal and fires on the next dispatch tick, so a sweep that first
 * sees the waiter late still sends. Nothing is armed once the key is decided.
 */
export async function scheduleWaitingPartySms(input: ScheduleWaitingPartySmsInput): Promise<void> {
  const event = WAITING_SMS_EVENT_BY_DIRECTION[input.direction];
  if (await isWaitingSmsDecided(input.meetingId)) {
    return;
  }
  const clockStart = expertClockStart(input.scheduledStart, input.waiterFirstJoinedAt);
  if (clockStart === null) {
    return;
  }
  const payload: MeetingWaitingSmsPayload = {
    correlationId: randomUUID(),
    meetingId: input.meetingId,
    scheduledStartIso: input.scheduledStart.toISOString(),
    companyId: input.companyId,
    expertProfileId: input.expertProfileId,
    // Seeded, then REBUILT by the guard at fire time.
    recipientUserId: null,
    recipientTimeZone: null,
    waitingPartyName: null,
  };
  const { outcome } = await scheduleNotification(event, payload, {
    key: meetingWaitingSmsKey(input.meetingId),
    at: new Date(clockStart.getTime() + WAITING_PARTY_SMS_DELAY_MS),
    mode: 'first_wins',
    recheck: MEETING_WAITING_SMS_RECHECK,
  });
  log.info({ meetingId: input.meetingId, event, outcome }, 'Waiting-party SMS armed');
}

interface ResolvedRecipient {
  readonly userId: string;
  readonly timeZone: string;
  readonly name: string | null;
}

type RecipientResult =
  | { readonly ok: true; readonly recipient: ResolvedRecipient }
  | {
      readonly ok: false;
      readonly reason: Extract<WaitingSmsSkipReason, 'no_booker' | 'no_expert'>;
    };

/** The delivering expert's first name, or `null` when none is stored. */
async function expertFirstName(expertUserId: string | null): Promise<string | null> {
  if (expertUserId === null) {
    return null;
  }
  const [names] = await usersRepository.findNamesByIds([expertUserId]);
  const firstName = names?.firstName?.trim() ?? '';
  return firstName.length > 0 ? firstName : null;
}

/** CLIENT direction — the booker only, while they still hold `participate` on the company. */
async function resolveBookerRecipient(
  meetingId: string,
  companyId: string,
  expertProfileId: string | null
): Promise<RecipientResult> {
  const bookerUserId = await clientPartyRecipientsRepository.findMeetingBookerUserId(meetingId);
  if (
    bookerUserId === null ||
    !(await clientPartyRecipientsRepository.bookerStillParticipatesInCompany(
      companyId,
      bookerUserId
    ))
  ) {
    return { ok: false, reason: 'no_booker' };
  }
  const [context, expertUserId] = await Promise.all([
    usersRepository.findTimezoneContext(bookerUserId, undefined),
    deliveringExpertUserId(expertProfileId),
  ]);
  return {
    ok: true,
    recipient: {
      userId: bookerUserId,
      timeZone: context?.savedTimezone ?? 'UTC',
      name: await expertFirstName(expertUserId),
    },
  };
}

/** EXPERT direction — the delivering expert's own user, never their agency's owners or admins. */
async function resolveExpertRecipient(
  companyId: string,
  expertProfileId: string | null
): Promise<RecipientResult> {
  const expertUserId = await deliveringExpertUserId(expertProfileId);
  if (expertUserId === null) {
    return { ok: false, reason: 'no_expert' };
  }
  const [context, company] = await Promise.all([
    usersRepository.findTimezoneContext(expertUserId, expertProfileId ?? undefined),
    companiesRepository.findNameById(companyId),
  ]);
  return {
    ok: true,
    recipient: {
      userId: expertUserId,
      timeZone: context?.expert?.timezone ?? context?.savedTimezone ?? 'UTC',
      name: company?.name ?? null,
    },
  };
}

function waitingSkip(reason: WaitingSmsSkipReason): { publish: false; reason: string } {
  return { publish: false, reason };
}

function directionFromEvent(event: string): WaitingSmsDirection | null {
  if (event === WAITING_SMS_EVENT_BY_DIRECTION.to_client) {
    return 'to_client';
  }
  return event === WAITING_SMS_EVENT_BY_DIRECTION.to_expert ? 'to_expert' : null;
}

/** Why the live direction no longer matches the armed one. */
function staleDirectionReason(
  armed: WaitingSmsDirection,
  facts: PresenceFacts
): Extract<WaitingSmsSkipReason, 'absent_party_joined' | 'waiter_left'> {
  const absentPartyEverPresent =
    armed === 'to_client' ? facts.clientSideEverPresent : facts.expertEverPresent;
  return absentPartyEverPresent ? 'absent_party_joined' : 'waiter_left';
}

/**
 * THE WAITING-PARTY GUARD. Publishes only if the same party is STILL alone, the consultation is
 * still on, and the single recipient is reachable by SMS now. Every skip is a normal outcome.
 *
 * ⚠ REPOSITORY THROWS PROPAGATE: the dispatch tick leaves the row `claimed` and retries it after
 * the claim TTL, so a transient DB failure never consumes the promise.
 */
export const meetingWaitingSmsRecheck: ScheduledRecheck = async (row) => {
  const decision = await decideWaitingSms(row);
  const meetingId = meetingIdFrom(row.payload);
  if (decision.publish) {
    log.info({ meetingId, event: row.event }, 'Waiting-party SMS publishing');
  } else {
    log.info({ meetingId, event: row.event, reason: decision.reason }, 'Waiting-party SMS skipped');
  }
  return decision;
};

async function decideWaitingSms(
  row: Parameters<ScheduledRecheck>[0]
): ReturnType<ScheduledRecheck> {
  const meetingId = meetingIdFrom(row.payload);
  const { companyId, correlationId, scheduledStartIso } = row.payload;
  const armed = directionFromEvent(row.event);
  if (
    meetingId === null ||
    typeof companyId !== 'string' ||
    companyId.length === 0 ||
    typeof correlationId !== 'string' ||
    correlationId.length === 0 ||
    typeof scheduledStartIso !== 'string' ||
    armed === null
  ) {
    return waitingSkip('malformed_payload');
  }
  const expertProfileId =
    typeof row.payload.expertProfileId === 'string' ? row.payload.expertProfileId : null;

  const state = await loadAbsenceState(meetingId);
  if (state === null) {
    return waitingSkip('meeting_missing');
  }
  if (isTerminal(state.meeting)) {
    return waitingSkip('meeting_terminal');
  }
  if ((await meetingOrigin(meetingId)) === 'call_now') {
    return waitingSkip('call_now');
  }
  // A live ring has its own SMS (`call.ringing`); this one would be a second text for one moment.
  if ((await meetingRingsRepository.findRingingForMeeting(meetingId)) !== undefined) {
    return waitingSkip('call_ringing');
  }
  if (await isWaitingSmsDecided(meetingId, row.id)) {
    return waitingSkip('already_decided');
  }
  if (waitingSmsDirection(state.facts) !== armed) {
    return waitingSkip(staleDirectionReason(armed, state.facts));
  }
  if (await isCaseNoLongerActive(meetingId)) {
    return waitingSkip('case_closed');
  }
  // ⚠ THE PAYLOAD NAMES THE OWNER, BUT THE MEETING DECIDES IT — compared, never substituted.
  const owner = await deliveringContextOwnerForMeeting(meetingId);
  if (owner === null) {
    return waitingSkip('owner_unresolved');
  }
  if (owner.companyId !== companyId || owner.expertProfileId !== expertProfileId) {
    return waitingSkip('owner_mismatch');
  }

  const resolved =
    armed === 'to_client'
      ? await resolveBookerRecipient(meetingId, companyId, expertProfileId)
      : await resolveExpertRecipient(companyId, expertProfileId);
  if (!resolved.ok) {
    return waitingSkip(resolved.reason);
  }
  const { userId, timeZone, name } = resolved.recipient;

  const calleeSide = armed === 'to_client' ? 'client' : 'expert';
  const eligibility = smsEligibility({
    calleeSide,
    consent: await usersRepository.findClientSmsConsent(userId),
    calleeOnline: await offlineCalleePresence.isOnline(userId),
    withinCallHours: isInsideSmsHours(new Date(), timeZone, calleeSide),
  });
  if (!eligibility.eligible) {
    return waitingSkip(eligibility.reason);
  }

  const payload: MeetingWaitingSmsPayload = {
    correlationId,
    meetingId,
    scheduledStartIso,
    companyId,
    expertProfileId,
    recipientUserId: userId,
    recipientTimeZone: timeZone,
    waitingPartyName: name,
  };
  return { publish: true, payload: { ...payload } };
}
