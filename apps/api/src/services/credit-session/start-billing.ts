/**
 * BAL-474 (ADR-1040 Amendment 7 §D / ADR-1044, billing Rule A — owner ruling D13) — THE START-BILLING
 * SEAM: open (when none exists) and CONNECT a Case meeting's credit session, at the moment billing is due.
 *
 * ⚠⚠ THE RULE. Before the scheduled start T, only the minutes the delivering expert and a client-side
 * participant were ACTUALLY TOGETHER bill, and they bill at SETTLEMENT (`togetherBeforeStartMs`, computed
 * from presence). The live meter starts at T. So this seam never connects before T: it connects at
 * `anchor = max(T, the start of the co-presence running now)`, and only when `now >= T` with an expert row
 * and a client row open. A pre-T open would buy only a hold and a card guard, and it would bring back a
 * one-shot latch, notices sent to an absent booker and the expert-invited-guest latch — so the session
 * opens HERE, at or after T, when billing starts. Nothing opens earlier: the server refuses a join more than
 * `CASE_JOIN_WINDOW_MINUTES` (3) before T (D16, `assertMeetingJoinable`), so an admission is at most that far
 * ahead; the terminal path is the backstop.
 *
 * ⚠ LEVEL-TRIGGERED, NOT A ONE-SHOT LATCH. It is called by the presence writer on EVERY co-present
 * reconcile (whatever the `markInProgress` compare-and-set returned) and by the meter sweep's first pass
 * (`runBillingStartPass`), which catches what no webhook fires for: a co-presence that spans T, a failed or
 * wallet-busy open, a D5.9 guard that clears later, a session a reschedule release cancelled. Both derive
 * the SAME anchor from the SAME rows, and `connect` is idempotent on `active`, so the first anchor wins.
 * Minutes before T come only from settlement's together term, and ticks cover only `[anchor, …)`, so the
 * two never overlap — and the Q1 no-refund clamp can never keep a charge for an empty pre-T room.
 *
 * ⚠ THE SAME EXPERT-INVITED-GUEST GUARD (ADR-1040 Amendment 7 §E) GATES BOTH BRANCHES. A call attended only by
 * guests the delivering expert invited never opens a session here, and never connects an EXISTING pending one
 * either (a member's in-window admission can leave one behind). Settlement applies the same guard afterwards.
 *
 * ⚠ PERMANENT DEFERRALS REPEAT, QUIETLY. `expert_invited_guest`, `expert_rate_missing`, `meeting_not_bookable`
 * and `booker_unattributable` do not clear on their own, and the pass's finder
 * (`listCaseMeetingsDueToStartBilling`) re-selects the meeting every minute while it stays co-present, so each is
 * logged at `debug`. The signal is the terminal path's own alarm (`settleSessionlessCaseMeeting` refuses and
 * alarms once); nothing here alarms. The repeat set is bounded: LIVE co-present calls only — the finder needs an
 * open expert row and an open client row, so a permanently deferred meeting leaves it when the call ends.
 *
 * ⚠⚠ **SYSTEM-ONLY. NEVER CALL THIS FROM A ROUTE.** It performs no actor authorization; its callers are the
 * presence writer (a Daily webhook or the lifecycle reconcile) and the meter sweep. It NEVER THROWS: a
 * failure is logged and the sweep retries; settlement bills from presence regardless.
 */
import {
  InvalidSessionTransitionError,
  creditSessionsRepository,
  meetingContextsRepository,
  type Meeting,
  type MeetingPresence,
  type OpenSessionInput,
} from '@balo/db';
import { SESSION_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import {
  currentCoPresenceStartedAt,
  isTerminalMeetingStatus,
  selectPrimaryMeetingContext,
} from '@balo/shared/meetings';
import { createLogger } from '@balo/shared/logging';
import * as Sentry from '@sentry/node';
import { connectSessionAsSystem } from './connect-session.js';
import {
  expertInvitedGuestGuard,
  onlyExpertInvitedGuestsAttended,
} from './expert-invited-guest-guard.js';
import { resolveOnBehalfOpenInput } from './open-on-behalf-of-booker.js';

const log = createLogger('credit-session');

/** The audit `trigger` a billing-start open carries (free text in the audit metadata; no schema). */
export const BILLING_START_TRIGGER = 'billing_start';

export type StartBillingOutcome =
  | { readonly kind: 'not_due' }
  | { readonly kind: 'not_co_present' }
  | {
      readonly kind: 'started';
      readonly sessionId: string;
      readonly opened: boolean;
      readonly connectedAt: Date;
    }
  | { readonly kind: 'already_metering'; readonly sessionId: string }
  | {
      readonly kind: 'deferred';
      readonly reason:
        | 'expert_invited_guest'
        | 'session_in_progress'
        | 'meeting_not_bookable'
        | 'booker_unattributable'
        | 'expert_rate_missing'
        | 'session_not_pending';
    }
  | { readonly kind: 'failed' };

/** The open rows reduced to what the seam reads. */
type OpenRow = Pick<MeetingPresence, 'party' | 'joinedAt' | 'leftAt' | 'userId'>;

/**
 * The client MEMBER to attribute a billing-start open to: the earliest-joined open `client` row that is a
 * user (a guest row has no `user_id`). `undefined` when only guests are present — the booker is used.
 */
function presentClientMember(openRows: readonly OpenRow[]): string | undefined {
  let earliest: OpenRow | undefined;
  for (const row of openRows) {
    if (row.party !== 'client' || row.userId === null || row.leftAt !== null) {
      continue;
    }
    if (earliest === undefined || row.joinedAt.getTime() < earliest.joinedAt.getTime()) {
      earliest = row;
    }
  }
  return earliest?.userId ?? undefined;
}

/** Open the meeting's session on behalf of a present member (else the booker). */
async function openForBillingStart(
  meeting: Meeting,
  onBehalfOfUserId: string | undefined
): Promise<
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly outcome: StartBillingOutcome }
> {
  const resolved = await resolveOnBehalfOpenInput({
    meetingId: meeting.id,
    openedBy: 'system',
    trigger: BILLING_START_TRIGGER,
    window: meeting,
    // Billing is starting because the call IS attended — a closed case never voids it.
    attended: true,
    ...(onBehalfOfUserId === undefined ? {} : { onBehalfOfUserId }),
    guard: expertInvitedGuestGuard(meeting.id),
  });
  if (!resolved.ok) {
    if (resolved.code === 'expert_invited_guest') {
      log.debug(
        { meetingId: meeting.id },
        'Billing not started — only guests the delivering expert invited are present'
      );
      return { ok: false, outcome: { kind: 'deferred', reason: 'expert_invited_guest' } };
    }
    if (resolved.code === 'meeting_not_bookable') {
      log.debug(
        { meetingId: meeting.id },
        'Billing not started — the meeting is not a billable Case'
      );
      return { ok: false, outcome: { kind: 'deferred', reason: 'meeting_not_bookable' } };
    }
    // `booker_unattributable` (and any future refusal) — the terminal path refuses it again and alarms.
    log.debug(
      { meetingId: meeting.id, code: resolved.code },
      'Billing not started — the meeting has no attributable booker; the terminal path refuses and alarms it'
    );
    return { ok: false, outcome: { kind: 'deferred', reason: 'booker_unattributable' } };
  }

  const open: OpenSessionInput = resolved.open;
  const opened = await creditSessionsRepository.open(open);
  if (opened.ok) {
    return { ok: true, sessionId: opened.session.id };
  }
  if (opened.code === 'meeting_session_exists') {
    // A racing path opened it first — use ITS id, never a re-read.
    return { ok: true, sessionId: opened.existingSessionId };
  }
  if (opened.code === 'session_in_progress') {
    log.info(
      { meetingId: meeting.id },
      'Billing not started — another live session holds the company wallet; the next pass retries'
    );
    return { ok: false, outcome: { kind: 'deferred', reason: 'session_in_progress' } };
  }
  if (opened.code === 'expert_rate_missing') {
    log.debug(
      { meetingId: meeting.id },
      'Billing not started — the delivering expert has no rate; the terminal path refuses and alarms it'
    );
    return { ok: false, outcome: { kind: 'deferred', reason: 'expert_rate_missing' } };
  }
  // `account_hold` / `settlement_pending` / `insufficient_no_mandate` are the GATED open's refusals; the
  // tolerant policy never returns them. Reaching here is a programming error.
  throw new Error(`billing-start open returned a gated refusal: ${opened.code}`);
}

/** "Is it a Case" is decided by the SAME rule admission and the sessionless path use: the primary context. */
async function isCaseMeeting(meetingId: string): Promise<boolean> {
  const primary = selectPrimaryMeetingContext(
    await meetingContextsRepository.listByMeeting(meetingId)
  );
  return primary.ok && primary.context.contextType === 'case';
}

/** The meeting's session (an existing one, else a fresh open on behalf of a present member), or why there is none. */
async function sessionToConnect(
  meeting: Meeting,
  openRows: readonly OpenRow[]
): Promise<
  | { readonly ok: true; readonly sessionId: string; readonly opened: boolean }
  | { readonly ok: false; readonly outcome: StartBillingOutcome }
> {
  const existing = await creditSessionsRepository.findIdByMeetingId(meeting.id);
  if (existing !== undefined) {
    return { ok: true, sessionId: existing.id, opened: false };
  }
  const attempt = await openForBillingStart(meeting, presentClientMember(openRows));
  return attempt.ok ? { ok: true, sessionId: attempt.sessionId, opened: true } : attempt;
}

/**
 * CONNECT a session at `anchor` and announce it, exactly once. Reads the session's status first (an End or cancel
 * may have landed), guards an EXISTING session against the expert-invited-guest rule, and reports
 * `already_metering` when another caller performed `pending → active` first.
 */
async function connectAndAnnounce(input: {
  readonly meeting: Meeting;
  readonly sessionId: string;
  readonly opened: boolean;
  readonly anchor: Date;
}): Promise<StartBillingOutcome> {
  const { meeting, sessionId, opened, anchor } = input;
  const session = await creditSessionsRepository.findById(sessionId);
  if (session === undefined || session.status !== 'pending') {
    if (session?.status === 'active' || session?.status === 'grace') {
      return { kind: 'already_metering', sessionId };
    }
    log.info(
      { meetingId: meeting.id, sessionId, status: session?.status },
      'Billing not started — the session is no longer pending (an End or cancel raced)'
    );
    return { kind: 'deferred', reason: 'session_not_pending' };
  }

  // ADR-1040 Amendment 7 §E, "not when billing starts": a session that already exists (a member's in-window
  // admission opened it) is guarded exactly like a fresh open — a call attended only by guests the delivering
  // expert invited must not start a meter. A session this call just opened already passed the guard.
  if (!opened && (await onlyExpertInvitedGuestsAttended(meeting.id, session.expertProfileId))) {
    log.debug(
      { meetingId: meeting.id, sessionId },
      'Billing not started — only guests the delivering expert invited are present'
    );
    return { kind: 'deferred', reason: 'expert_invited_guest' };
  }

  let connectResult: Awaited<ReturnType<typeof connectSessionAsSystem>>;
  try {
    connectResult = await connectSessionAsSystem(sessionId, { now: anchor });
  } catch (error) {
    if (error instanceof InvalidSessionTransitionError) {
      // An End or cancel landed between the status read and the connect — an expected race, not a fault.
      log.info(
        { meetingId: meeting.id, sessionId, error: error.message },
        'Billing not started — the session left `pending` before it could connect (an End or cancel raced)'
      );
      return { kind: 'deferred', reason: 'session_not_pending' };
    }
    throw error;
  }
  const { session: connected, transitioned } = connectResult;
  if (!transitioned) {
    // Another caller (the writer or the pass) performed `pending → active` first: its anchor wins, and it
    // alone emits the event and the log.
    return { kind: 'already_metering', sessionId };
  }
  // BAL-466 (D7) — `session_started` fires HERE, server-side, at the real connect seam, exactly once: only
  // the caller that performed the transition reaches this line.
  trackServer(SESSION_SERVER_EVENTS.SESSION_STARTED, {
    session_id: connected.id,
    meeting_id: meeting.id,
    expert_profile_id: connected.expertProfileId,
    // ⚠ THE MARKED-UP CLIENT RATE — never `expertRateMinorPerMinute` and never `baloFeeBps`.
    rate_per_minute_minor: connected.clientRateMinorPerMinute,
    // ⚠ = company_id. There is no acting human on a system-observed transition.
    distinct_id: connected.companyId,
  });
  log.info(
    { meetingId: meeting.id, sessionId, opened, connectedAt: anchor.toISOString() },
    'Billing started — the meter runs from the scheduled start or the co-presence, whichever is later'
  );
  return { kind: 'started', sessionId, opened, connectedAt: anchor };
}

/**
 * Start billing for this meeting if it is due. See the module docblock. `openRows` are the meeting's
 * currently OPEN presence rows (the writer already holds them from `listOpen`; the pass reads them).
 *
 * Reads, in order: none when `now < T` or the meeting is terminal or nobody is co-present; then the meeting's
 * contexts; then `findIdByMeetingId`; then, only if a session exists, its status. NEVER THROWS.
 */
export async function startBillingIfDue(input: {
  readonly meeting: Meeting;
  readonly openRows: readonly OpenRow[];
  readonly now: Date;
}): Promise<StartBillingOutcome> {
  const { meeting, openRows, now } = input;
  try {
    if (
      now.getTime() < meeting.scheduledStart.getTime() ||
      isTerminalMeetingStatus(meeting.status)
    ) {
      return { kind: 'not_due' };
    }
    const coPresentSince = currentCoPresenceStartedAt(openRows);
    if (coPresentSince === null) {
      return { kind: 'not_co_present' };
    }
    // The meter never starts before T: the anchor is T when the co-presence spans it.
    const anchor = new Date(Math.max(meeting.scheduledStart.getTime(), coPresentSince.getTime()));

    if (!(await isCaseMeeting(meeting.id))) {
      log.debug(
        { meetingId: meeting.id },
        'Billing not started — the meeting is not a billable Case'
      );
      return { kind: 'deferred', reason: 'meeting_not_bookable' };
    }
    const target = await sessionToConnect(meeting, openRows);
    if (!target.ok) {
      return target.outcome;
    }
    return await connectAndAnnounce({
      meeting,
      sessionId: target.sessionId,
      opened: target.opened,
      anchor,
    });
  } catch (error) {
    log.error(
      {
        meetingId: meeting.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Billing could not be started — not metering yet; the next sweep retries, and settlement bills from presence regardless'
    );
    Sentry.captureException(error, { extra: { meetingId: meeting.id, op: 'start_billing' } });
    return { kind: 'failed' };
  }
}
