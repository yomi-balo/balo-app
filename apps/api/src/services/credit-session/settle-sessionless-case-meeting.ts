/**
 * BAL-474 (ADR-1040 Amendment 7 §C/§D, D5.3, D5.4, D5.5, D5.9, D7.5) — OPEN AND SETTLE A SESSIONLESS
 * ENDED CASE MEETING, on behalf of its booker, from EVERY terminal path.
 *
 * WHY IT EXISTS. A Case consultation's credit session used to open only when a client MEMBER was
 * admitted (BAL-466). So a client no-show had no session and the expert who waited the floor was
 * unpaid; a guest-only call was unbilled; and an admission whose open was refused or threw was lost
 * for good. This is the terminal path that closes all three: when a Case meeting ends with NO session
 * and its presence settles as `no_show_client` or `held`, it opens the session — overdraft-tolerant,
 * `opened_by = 'system'`, the booker as attribution — and settles it in ONE transaction, then runs the
 * SAME post-commit tail every presence settlement runs.
 *
 * ⚠⚠ **SYSTEM-ONLY. NEVER CALL THIS FROM A ROUTE.** It performs no actor authorization and reaches the
 * off-session charge tail against the company's stored mandate. Its callers are the three terminal
 * paths only: the lifecycle sweep's rules (`lifecycle_sweep`), a human End (`human_end`) and the
 * durability backstop (`backstop`).
 *
 * ⚠ KEYED ON THE SETTLEMENT SHAPE, NOT THE RULE (D5.3). ADR-1040 lifecycle step 7 already says "the
 * expert may end the call at that point but must remain present for the full 15 minutes to earn the
 * block": an expert who presses End after the floor, or leaves after it before the sweep's next tick
 * (`abandoned_wait`, shape `no_show_client`), MUST be paid. So the open runs for the two BILLABLE
 * shapes — `no_show_client` and `held` — from every rule. The two zero shapes (`missed_call`,
 * `abandoned_wait`) bill nothing and write a `not_billable` marker so the row leaves the backstop's
 * finder. The shape is computed BEFORE any refusal branch (R1-F5, D7.5): only a billable shape alarms.
 *
 * ⚠ ONE SETTLEMENT PATH, NEVER A SECOND. This module does no minute maths and writes no ledger row: the
 * shape and figures come from `computeMeetingPresenceSettlement`, the transaction is the repository's
 * `openAndSettleFromPresence` (which composes the SAME open and the SAME settlement body every other
 * path uses), and the tail is `completePresenceSettlement`. Pinned by
 * `invariants/expert-paid-for-time-made-available.test.ts` (a source scan of this file).
 *
 * ⚠ IDEMPOTENT — NEVER TWO SESSIONS FOR ONE MEETING (AD-4). The finder's `NOT EXISTS`, the in-lock
 * `meeting_session_exists` check inside `open` and the single transaction make an inline attempt and the
 * backstop race harmlessly: the loser settles the winner's session and gets `already_settled`.
 *
 * ⚠ REFUSALS THAT STAY (they mark the meeting and alarm once; every one is a real loss): no coherent Case
 * engagement (`meeting_not_bookable`), no attributable booker (`booker_unattributable` — never a
 * fabricated actor), no expert rate (`expert_rate_missing`), and a deferral that can no longer be
 * retried (`retry_exhausted`). `wallet_missing` is gone: the wallet is provisioned (D7.5).
 */
import {
  creditSessionsRepository,
  meetingContextsRepository,
  meetingsRepository,
  type MeetingOutcome,
  type OpenToleratedGate,
} from '@balo/db';
import type { MeetingSettlement } from '@balo/shared/credit';
import {
  meetingVenueReadyAt,
  selectPrimaryMeetingContext,
  type MeetingVenueStampFields,
} from '@balo/shared/meetings';
import { createLogger } from '@balo/shared/logging';
import { resolveCaseBillingSubject } from './case-billing-subject.js';
import { expertInvitedGuestGuard } from './expert-invited-guest-guard.js';
import { resolveOnBehalfOpenInput } from './open-on-behalf-of-booker.js';
import { reportSessionOpenRefused } from './report-session-open-refused.js';
import {
  buildSettlementRepoFields,
  completePresenceSettlement,
  computeMeetingPresenceSettlement,
  settleMeetingIfBillable,
  type SettleFromPresenceResult,
} from './settle-from-presence.js';

const log = createLogger('credit-session');

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** The finder ignores a meeting that ended more recently than this — the inline path had its go. */
export const SESSIONLESS_BACKSTOP_GRACE_MINUTES = 2;
/** The finder's window, bounded on BOTH `scheduled_start` and `ended_at` (D7.5). */
export const SESSIONLESS_BACKSTOP_WINDOW_HOURS = 72;
/** A still-sessionless meeting is exhausted on the FIRST attempt past this age, whenever that runs. */
export const SESSIONLESS_BACKSTOP_RETRY_HOURS = 25;
/** Batch bound on the backstop pass; the pass logs `warn` when the batch FILLS. */
export const SESSIONLESS_BACKSTOP_BATCH_LIMIT = 100;

/**
 * Is this meeting's finder window about to CLOSE (`scheduled_start <= now − 71h`, i.e. inside the
 * finder's LAST hour)? The finder drops a row at `scheduled_start + 72h` whatever its age since
 * `ended_at`, so a meeting that ended long after its scheduled start can reach the finder's edge
 * before the 25-hour retry exhaustion does. An attempt that is deferred there has no further tick to
 * retry on: it must be exhausted, loudly, instead of aging out silently (D5.5, D10.2).
 */
export function backstopWindowClosing(meeting: { scheduledStart: Date }, now: Date): boolean {
  return (
    meeting.scheduledStart.getTime() <=
    now.getTime() - (SESSIONLESS_BACKSTOP_WINDOW_HOURS - 1) * MS_PER_HOUR
  );
}

/**
 * Can a deferral for this meeting still be retried by a backstop pass? False once the meeting is in
 * the finder's last hour (or outside the window entirely) — see {@link backstopWindowClosing}. The
 * inline path exhausts a deferral that fails this at once (§D.5).
 */
export function withinBackstopWindow(meeting: { scheduledStart: Date }, now: Date): boolean {
  return !backstopWindowClosing(meeting, now);
}

export type SessionlessSettleTrigger = 'lifecycle_sweep' | 'human_end' | 'backstop';

export type SessionlessRefusalReason =
  | 'meeting_not_bookable'
  | 'booker_unattributable'
  | 'expert_rate_missing'
  | 'retry_exhausted';

export type SessionlessCaseMeetingResult =
  | { readonly kind: 'settled_existing_session'; readonly outcome: SettleFromPresenceResult }
  | {
      readonly kind: 'opened_and_settled';
      readonly sessionId: string;
      readonly toleratedGates: readonly OpenToleratedGate[];
      readonly outcome: SettleFromPresenceResult;
    }
  | {
      readonly kind: 'not_billable';
      readonly reason:
        | 'meeting_not_found'
        | 'meeting_not_terminal'
        | 'not_a_case_meeting'
        | 'zero_shape'
        | 'expert_invited_guest_only'
        | 'case_closed_before_start';
    }
  | {
      readonly kind: 'deferred';
      readonly reason: 'session_in_progress';
      readonly outcome: MeetingSettlement['outcome'];
    }
  | { readonly kind: 'refused'; readonly reason: SessionlessRefusalReason };

/** Everything the marker / alarm helpers need about one attempt. */
interface AttemptContext {
  readonly meetingId: string;
  readonly trigger: SessionlessSettleTrigger;
  readonly settlement: MeetingSettlement;
  readonly companyId: string | null;
}

/**
 * A PERMANENT refusal: write the terminal marker (which also resolves `meetings.outcome`
 * first-write-wins, in the SAME transaction — never outside one) and raise the alarm once. The marker
 * removes the meeting from the backstop's finder forever, so the alarm cannot repeat.
 */
async function refuse(
  reason: Exclude<SessionlessRefusalReason, 'retry_exhausted'>,
  ctx: AttemptContext
): Promise<SessionlessCaseMeetingResult> {
  await creditSessionsRepository.markSessionlessCaseMeeting({
    meetingId: ctx.meetingId,
    disposition: 'refused',
    reason,
    trigger: ctx.trigger,
    shape: ctx.settlement.shape,
    outcome: ctx.settlement.outcome,
  });
  await reportSessionOpenRefused(reason, {
    meetingId: ctx.meetingId,
    companyId: ctx.companyId,
    userId: null,
    openedBy: 'system',
  });
  return { kind: 'refused', reason };
}

/**
 * The two resolution outcomes that mean NOTHING IS OWED (no alarm, a `not_billable` marker so the row
 * leaves the backstop's finder), keyed by the resolver's code:
 *   · `expert_invited_guest` (D5.9) — the delivering expert invited the only client-party attendee, so
 *     the floor no-show must not be converted into a `held` bill on the client (a `warn`);
 *   · `case_closed_before_start` (D10.5) — the client closed the case before the meeting started, so
 *     the expert's presence was never delivery against an open case (an `info`).
 */
const NOTHING_OWED = {
  expert_invited_guest: {
    reason: 'expert_invited_guest_only',
    level: 'warn',
    message:
      'Sessionless held call attended only by guests the delivering expert invited — not billed on the client',
  },
  case_closed_before_start: {
    reason: 'case_closed_before_start',
    level: 'info',
    message: 'Sessionless Case meeting not billed — the case was closed before the meeting started',
  },
} as const;

async function markNothingOwed(
  code: keyof typeof NOTHING_OWED,
  ctx: AttemptContext
): Promise<SessionlessCaseMeetingResult> {
  const { reason, level, message } = NOTHING_OWED[code];
  log[level]({ meetingId: ctx.meetingId, trigger: ctx.trigger }, message);
  await creditSessionsRepository.markSessionlessCaseMeeting({
    meetingId: ctx.meetingId,
    disposition: 'not_billable',
    reason,
    trigger: ctx.trigger,
    shape: ctx.settlement.shape,
    outcome: ctx.settlement.outcome,
  });
  return { kind: 'not_billable', reason };
}

/** A deferral the backstop can never retry: mark it exhausted and alarm once. */
async function exhaust(ctx: AttemptContext): Promise<SessionlessCaseMeetingResult> {
  await creditSessionsRepository.markSessionlessCaseMeeting({
    meetingId: ctx.meetingId,
    disposition: 'retry_exhausted',
    reason: 'session_in_progress',
    trigger: ctx.trigger,
    shape: ctx.settlement.shape,
    outcome: ctx.settlement.outcome,
  });
  await reportSessionOpenRefused('retry_exhausted', {
    meetingId: ctx.meetingId,
    companyId: ctx.companyId,
    userId: null,
    openedBy: 'system',
  });
  return { kind: 'refused', reason: 'retry_exhausted' };
}

/**
 * The backstop pass's exhaustion (D5.5, D7.5): a candidate still sessionless on the first attempt
 * past {@link SESSIONLESS_BACKSTOP_RETRY_HOURS}, or whose attempt threw and billed nothing. Writes the
 * `retry_exhausted` marker (so the row leaves the finder) and raises the alarm once. The billing
 * company is resolved best-effort — an alarm must never itself fail the pass.
 */
export async function exhaustSessionlessCaseMeeting(input: {
  readonly meetingId: string;
  readonly reason: 'session_in_progress' | 'error';
  readonly trigger: SessionlessSettleTrigger;
  /** The `meetings.outcome` the deferred attempt computed — resolved first-write-wins with the marker. */
  readonly outcome?: MeetingSettlement['outcome'];
}): Promise<void> {
  const { meetingId, reason, trigger, outcome } = input;
  let companyId: string | null = null;
  try {
    companyId =
      (await resolveCaseBillingSubject(meetingId, { requireActive: false }))?.companyId ?? null;
  } catch (error) {
    // Best-effort — the marker and the alarm matter more than the company label.
    log.warn(
      {
        meetingId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Sessionless exhaustion could not resolve the billing company — alarming without it'
    );
  }
  await creditSessionsRepository.markSessionlessCaseMeeting({
    meetingId,
    disposition: 'retry_exhausted',
    reason,
    trigger,
    ...(outcome === undefined ? {} : { outcome }),
  });
  await reportSessionOpenRefused('retry_exhausted', {
    meetingId,
    companyId,
    userId: null,
    openedBy: 'system',
  });
}

/**
 * The `meetings.outcome` a zero-shape marker resolves (first-write-wins). Presence alone reads a
 * meeting nobody delivering attended as `missed_call`, but when its call room was never ready nobody
 * COULD join, and BAL-581 records that as `venue_unavailable`, never as the expert's missed call. The
 * lifecycle sweep's rule 5 has already written that label; this covers the paths that leave the
 * outcome unset (a human End, and the backstop after one), so they reach the same label.
 */
function zeroShapeOutcome(
  meeting: MeetingVenueStampFields,
  settlement: MeetingSettlement
): MeetingOutcome {
  if (settlement.shape === 'missed_call' && meetingVenueReadyAt(meeting) === null) {
    return 'venue_unavailable';
  }
  return settlement.outcome;
}

/**
 * Open and settle ONE sessionless ended Case meeting — or settle the session it already has, or record
 * why nothing is owed. See the module docblock; the flow is plan §C.6, step for step.
 *
 * Thrown errors PROPAGATE: the callers' per-row catches log them and the backstop retries. `now`
 * defaults to the wall clock.
 */
export async function settleSessionlessCaseMeeting(input: {
  readonly meetingId: string;
  readonly trigger: SessionlessSettleTrigger;
  /** ADR-1030; `null` = the system-actor exemption (the sweep and the backstop). */
  readonly actorUserId: string | null;
  readonly now?: Date;
}): Promise<SessionlessCaseMeetingResult> {
  const { meetingId, trigger, actorUserId } = input;
  const now = input.now ?? new Date();

  // 1. A session already exists ⇒ this is the ordinary presence settlement.
  const existing = await creditSessionsRepository.findIdByMeetingId(meetingId);
  if (existing !== undefined) {
    return {
      kind: 'settled_existing_session',
      outcome: await settleMeetingIfBillable({ meetingId, actorUserId, now, trigger }),
    };
  }

  // 2. The meeting, and it must be terminal.
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    log.info({ meetingId, trigger }, 'Sessionless settlement skipped — meeting not found');
    return { kind: 'not_billable', reason: 'meeting_not_found' };
  }
  if (meeting.status !== 'ended') {
    log.info({ meetingId, trigger }, 'Sessionless settlement skipped — the meeting is not ended');
    return { kind: 'not_billable', reason: 'meeting_not_terminal' };
  }

  // 3. Only a meeting whose PRIMARY context is a Case bills here. The finder mirrors this rule in SQL,
  //    so a meeting that is not a Case is never selected — silent, no marker.
  const primary = selectPrimaryMeetingContext(
    await meetingContextsRepository.listByMeeting(meetingId)
  );
  if (!primary.ok || primary.context.contextType !== 'case') {
    log.info({ meetingId, trigger }, 'Sessionless settlement skipped — not a Case meeting');
    return { kind: 'not_billable', reason: 'not_a_case_meeting' };
  }

  // 4. THE SHAPE, BEFORE ANY REFUSAL BRANCH (R1-F5, D7.5). The two zero shapes owe nothing: mark them
  //    so the row leaves the finder, resolve `meetings.outcome` in the same transaction, and stay silent.
  const settlement = await computeMeetingPresenceSettlement({
    meeting,
    sessionId: null,
    minutesAlreadyDrawn: 0,
    now,
    // No session yet, so the delivering expert comes from the case's own engagement row.
    resolveExpertProfileId: async () =>
      (await resolveCaseBillingSubject(meetingId, { requireActive: false }))?.expertProfileId ??
      null,
  });
  if (settlement.shape === 'missed_call' || settlement.shape === 'abandoned_wait') {
    await creditSessionsRepository.markSessionlessCaseMeeting({
      meetingId,
      disposition: 'not_billable',
      reason: settlement.shape,
      trigger,
      shape: settlement.shape,
      outcome: zeroShapeOutcome(meeting, settlement),
    });
    log.info(
      { meetingId, trigger, shape: settlement.shape },
      'Sessionless Case meeting owes nothing — a zero settlement shape'
    );
    return { kind: 'not_billable', reason: 'zero_shape' };
  }

  // ── From here the shape is billable (`no_show_client` | `held`), so every refusal is a real loss. ──
  // 5–8. The subject (coherence only — D5.6), the D5.9 guard on a `held` shape, the booker (never a
  //      fabricated actor) and the wallet (provisioned when missing — D7.5).
  const resolved = await resolveOnBehalfOpenInput({
    meetingId,
    openedBy: 'system',
    trigger,
    window: meeting,
    // D12.1(c) — a `held` call was ATTENDED: a case closed before the start never voids it. Only a
    // floor no-show is voided by the closure.
    attended: settlement.shape === 'held',
    guard: settlement.shape === 'held' ? expertInvitedGuestGuard(meetingId) : undefined,
  });
  const ctx = (companyId: string | null): AttemptContext => ({
    meetingId,
    trigger,
    settlement,
    companyId,
  });
  if (!resolved.ok) {
    if (resolved.code === 'expert_invited_guest' || resolved.code === 'case_closed_before_start') {
      return markNothingOwed(resolved.code, ctx(resolved.companyId));
    }
    return refuse(resolved.code, ctx(resolved.companyId));
  }

  // 9. Open AND settle in ONE transaction (AD-3) — the tolerant open, the in-lock one-session-per-meeting
  //    check, the hold, the presence settlement body — then the same post-commit tail.
  const result = await creditSessionsRepository.openAndSettleFromPresence({
    open: { ...resolved.open, openedBy: 'system' },
    settlement: buildSettlementRepoFields(settlement, {
      minutesAlreadyDrawn: 0,
      actorUserId,
      now,
    }),
  });

  if (!result.ok) {
    return handleOpenRefusal(result.code, {
      ctx: ctx(resolved.subject.companyId),
      meeting,
      now,
      actorUserId,
    });
  }

  const sessionId = result.settled.session.id;
  const outcome = await completePresenceSettlement({
    repoResult: result.settled,
    settlement,
    meetingId,
    sessionId,
    now,
  });
  log.info(
    {
      meetingId,
      sessionId,
      trigger,
      shape: settlement.shape,
      toleratedGates: result.toleratedGates,
      overdraftMinor: result.settled.overdraftMinor,
    },
    'Sessionless Case meeting opened and settled on behalf of the booker'
  );
  return {
    kind: 'opened_and_settled',
    sessionId,
    toleratedGates: result.toleratedGates,
    outcome,
  };
}

/**
 * The repository refused the open. `meeting_session_exists` means a racing path won: settle THAT
 * session. `session_in_progress` is transient: defer to the backstop while it can still retry, else
 * exhaust at once. `expert_rate_missing` is permanent. The three gated codes are unreachable under the
 * tolerant policy — a programming error, so they throw.
 */
async function handleOpenRefusal(
  code:
    | 'meeting_session_exists'
    | 'session_in_progress'
    | 'expert_rate_missing'
    | 'account_hold'
    | 'settlement_pending'
    | 'insufficient_no_mandate',
  input: {
    readonly ctx: AttemptContext;
    readonly meeting: { readonly scheduledStart: Date };
    readonly now: Date;
    readonly actorUserId: string | null;
  }
): Promise<SessionlessCaseMeetingResult> {
  const { ctx, meeting, now, actorUserId } = input;
  if (code === 'meeting_session_exists') {
    return {
      kind: 'settled_existing_session',
      outcome: await settleMeetingIfBillable({
        meetingId: ctx.meetingId,
        actorUserId,
        now,
        trigger: ctx.trigger,
      }),
    };
  }
  if (code === 'session_in_progress') {
    if (withinBackstopWindow(meeting, now)) {
      log.warn(
        { meetingId: ctx.meetingId, trigger: ctx.trigger },
        'Sessionless Case meeting deferred — another live session holds the company wallet; the backstop retries'
      );
      return { kind: 'deferred', reason: 'session_in_progress', outcome: ctx.settlement.outcome };
    }
    return exhaust(ctx);
  }
  if (code === 'expert_rate_missing') {
    return refuse('expert_rate_missing', ctx);
  }
  log.error(
    { meetingId: ctx.meetingId, code },
    'A tolerant sessionless open returned a gated refusal — unreachable under the overdraft-tolerant policy'
  );
  throw new Error(`sessionless open returned a gated refusal: ${code}`);
}
