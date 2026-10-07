/**
 * BAL-474 (ADR-1040 Amendment 7 §C/§E, D3, D4, D5.6, D5.9) — OPEN A PRESENCE CREDIT SESSION ON BEHALF
 * OF A MEETING'S BOOKER.
 *
 * Two callers, one primitive:
 *   · a client-side, EMAIL-invited GUEST's admission (`join-meeting.ts` → `openSessionOnBehalfOfBooker`,
 *     `openedBy: 'guest'`) — the guest holds no company membership and no `CONSUME_CREDITS`, but the
 *     product intent (D3) is that a consultation attended only by a client's guest is still a billed
 *     consultation: a client admin books, then hands the call to the colleague who talks to the expert;
 *   · the SESSIONLESS terminal-path open (`settle-sessionless-case-meeting.ts`, `openedBy: 'system'`),
 *     via {@link resolveOnBehalfOpenInput}.
 *
 * ⚠⚠ **SYSTEM-ONLY. NEVER CALL THIS FROM A ROUTE.** It performs NO ACTOR AUTHORIZATION, deliberately:
 * the "actor" is the booker, who is attribution only (D4). Its callers are the two server paths above,
 * each of which has already proven the meeting and (for a guest) the token. A route reaching it would let
 * any caller who can name a `meetingId` open — and so bill — a client company's session.
 *
 * ⚠ THE BOOKER IS ATTRIBUTION, NEVER AUTHORITY (D4, CLAUDE.md "rights sit on company membership and
 * survive individual departures; attribution columns record the individual actor"). So:
 *   · `initiating_member_id` = the booker, and NO `CONSUME_CREDITS` re-check runs — a booker who has
 *     since left the company still bills THEIR company for a consultation they booked;
 *   · every booker-addressed notice for the session is gated on the booker's CURRENT membership
 *     (`notify.ts`, D5.7), so a departed booker is never sent company billing data;
 *   · the IDOR-relevant COHERENCE checks still run — one `case` context, the engagement exists and is a
 *     case, and the company and expert come from THAT row (`resolveCaseBillingSubject`, D5.6). Not
 *     `engagement.status === 'active'`: a client who resolves the case while the expert waits must not
 *     void the expert's floor. The one status rule that DOES apply (D10.5): a case closed BEFORE the
 *     meeting's scheduled start is not billed — `case_closed_before_start`, no alarm.
 *
 * ⚠ A NULL OR MISSING BOOKER IS A REFUSAL, NEVER A FABRICATED ACTOR (AD-7). The booker is the
 * `meeting.booked` audit row's actor (there is no booker column — `schema/meetings.ts`, BAL-129 D12);
 * only the dev seeder writes it NULL. A fallback would attribute ledger rows to someone who never
 * booked.
 */
import {
  clientPartyRecipientsRepository,
  creditSessionsRepository,
  creditWalletsRepository,
  db,
  expertsRepository,
  meetingsRepository,
  partyMembershipsRepository,
  type OpenSessionInput,
  type OpenToleratedGate,
} from '@balo/db';
import { caseClosedBeforeStart, estimatedMinutesForWindow } from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';
import { resolveCaseBillingSubject, type CaseBillingSubject } from './case-billing-subject.js';

const log = createLogger('credit-session');

/** The two on-behalf labels — a `client` open acts as the member and never comes through here. */
export type OnBehalfOpenedBy = 'guest' | 'system';

/**
 * The fully-resolved repository input for an on-behalf open: the tolerant policy, the presence
 * provenance, the meeting + engagement it bills, and the booker as `initiatingMemberId`. Pinned by
 * type — `openAndSettleFromPresence` accepts exactly this shape for `openedBy: 'system'`.
 */
export type OnBehalfOpenInput = OpenSessionInput & {
  readonly meetingId: string;
  readonly engagementId: string;
  readonly durationSource: 'presence';
  readonly fundingPolicy: 'overdraft_tolerant';
  readonly openedBy: OnBehalfOpenedBy;
};

export type ResolveOnBehalfOpenFailure =
  | { readonly ok: false; readonly code: 'meeting_not_bookable'; readonly companyId: string | null }
  | {
      readonly ok: false;
      readonly code: 'booker_unattributable';
      readonly companyId: string | null;
    }
  | {
      readonly ok: false;
      readonly code: 'expert_invited_guest';
      readonly companyId: string | null;
    }
  | {
      readonly ok: false;
      readonly code: 'case_closed_before_start';
      readonly companyId: string | null;
    };

export type ResolveOnBehalfOpenResult =
  | {
      readonly ok: true;
      readonly open: OnBehalfOpenInput;
      readonly subject: CaseBillingSubject;
    }
  | ResolveOnBehalfOpenFailure;

/**
 * The meeting's booker — the actor of its `meeting.booked` audit row, or `null` when none was
 * recorded or the actor is NULL (seeded / system-booked). Single writer: `recordMeetingBooked`
 * inside `meetingsRepository.create`; reschedules update the same row and never re-write it.
 * Delegates to the one definition, `clientPartyRecipientsRepository.findMeetingBookerUserId`.
 */
export async function resolveMeetingBooker(meetingId: string): Promise<string | null> {
  return clientPartyRecipientsRepository.findMeetingBookerUserId(meetingId);
}

/** The user, if (and only if) they are a live member of the company; otherwise `undefined`. */
async function liveCompanyMemberOrUndefined(
  companyId: string,
  userId: string | undefined
): Promise<string | undefined> {
  if (userId === undefined) {
    return undefined;
  }
  const role = await partyMembershipsRepository.getMemberRole('company', companyId, userId);
  return role === undefined ? undefined : userId;
}

/**
 * Resolve everything an on-behalf open needs, in the plan's order (§C.6 steps 5–8):
 *   1. the billing SUBJECT — coherence only (`requireActive: false`), company and expert from the
 *      engagement's own row;
 *   2. the optional GUARD, after the subject resolves and before any other read (D5.9 — the
 *      guest path's "invited by the delivering expert" check);
 *   3. the BOOKER — refused, never fabricated, when absent;
 *   4. the WALLET — PROVISIONED when missing (D7.5): `ensureForCompany` on `db`, BEFORE the open's
 *      transaction and outside it, because that transaction's first statement is the advisory lock on
 *      a wallet id, so the wallet must already exist. Idempotent under a race.
 *   5. the estimate — `estimatedMinutesForWindow`, the ONE window estimator every path shares.
 *
 * It reads NO hold, NO funding snapshot and NO low-balance mode: admission is never braked (D6.1,
 * plan §F.7) and the open is overdraft-tolerant — session-scoped settlement is what makes that safe.
 */
export async function resolveOnBehalfOpenInput(input: {
  readonly meetingId: string;
  readonly openedBy: OnBehalfOpenedBy;
  readonly meetingGuestId?: string;
  /** Which path is opening — recorded on the `credit_session.opened_on_behalf` audit row. */
  readonly trigger: string;
  /**
   * The meeting's scheduled window, when the caller already holds the row — saves the one read that
   * sizes the estimate. Omitted ⇒ read here.
   */
  readonly window?: { readonly scheduledStart: Date; readonly scheduledEnd: Date };
  /**
   * BAL-474 (D12.1c) — was the call ATTENDED (a client-side participant was present, or the terminal
   * shape is `held`)? An attended call bills whatever the case's status; only an UNATTENDED one (a
   * no-show, or a guest admission with nobody yet in the call) is voided by a case closed before the
   * meeting started. REQUIRED, so a new caller must decide.
   */
  readonly attended: boolean;
  /**
   * BAL-474 (Rule A) — the client MEMBER attributed with the open when one is present in the call (the
   * billing-start seam passes the earliest-joined open member). Omitted ⇒ the meeting's booker, exactly
   * as before. Attribution only — never authority (D4).
   *
   * ⚠ R6F-16 — it is honoured ONLY while that user is a LIVE member of the engagement's company (read from the
   * membership table, not from the presence row): a member removed mid-call whose row is still open must not be
   * named on the session, so a removed member falls back to the booker.
   */
  readonly onBehalfOfUserId?: string;
  readonly guard?: (subject: CaseBillingSubject) => Promise<'expert_invited_guest' | undefined>;
}): Promise<ResolveOnBehalfOpenResult> {
  const { meetingId, openedBy } = input;

  const subject = await resolveCaseBillingSubject(meetingId, { requireActive: false });
  if (subject === undefined) {
    return { ok: false, code: 'meeting_not_bookable', companyId: null };
  }

  const window = input.window ?? (await meetingsRepository.findById(meetingId));
  if (window === undefined) {
    return { ok: false, code: 'meeting_not_bookable', companyId: subject.companyId };
  }

  // D10.5 / D12.1(c) — a NO-SHOW on a case closed BEFORE the meeting's scheduled start owes nothing (a
  // client who resolves it while the expert waits, AFTER the start, still owes the floor). It voids ONLY
  // an unattended call: an attended one bills, whatever the case's status. Nothing alarms.
  if (!input.attended && caseClosedBeforeStart(subject, window.scheduledStart)) {
    return { ok: false, code: 'case_closed_before_start', companyId: subject.companyId };
  }

  if (input.guard !== undefined) {
    const verdict = await input.guard(subject);
    if (verdict !== undefined) {
      return { ok: false, code: verdict, companyId: subject.companyId };
    }
  }

  const attributedMemberId = await liveCompanyMemberOrUndefined(
    subject.companyId,
    input.onBehalfOfUserId
  );
  const bookerUserId = attributedMemberId ?? (await resolveMeetingBooker(meetingId));
  if (bookerUserId === null) {
    return { ok: false, code: 'booker_unattributable', companyId: subject.companyId };
  }

  const wallet = await creditWalletsRepository.ensureForCompany(db, subject.companyId);

  const open: OnBehalfOpenInput = {
    walletId: wallet.id,
    companyId: subject.companyId,
    expertProfileId: subject.expertProfileId,
    initiatingMemberId: bookerUserId,
    estimatedMinutes: estimatedMinutesForWindow(window.scheduledStart, window.scheduledEnd),
    meetingId,
    engagementId: subject.engagementId,
    // BAL-466 (D4) — the enabling condition for the ENTIRE settlement engine.
    durationSource: 'presence',
    fundingPolicy: 'overdraft_tolerant',
    openedBy,
    trigger: input.trigger,
    ...(input.meetingGuestId === undefined ? {} : { meetingGuestId: input.meetingGuestId }),
  };
  return { ok: true, open, subject };
}

export type OpenOnBehalfFailureCode =
  | 'meeting_not_bookable'
  | 'booker_unattributable'
  | 'expert_rate_missing'
  | 'session_in_progress'
  | 'meeting_session_exists'
  | 'expert_invited_guest'
  | 'case_closed_before_start';

export type OpenSessionOnBehalfResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly toleratedGates: readonly OpenToleratedGate[];
    }
  | {
      readonly ok: false;
      readonly code: OpenOnBehalfFailureCode;
      readonly companyId: string | null;
    };

/**
 * A client-side, EMAIL-invited guest's admission opens the billed presence session, on behalf of the
 * booker (D3). The caller (`join-meeting.ts`) has already applied the presence predicate — only a guest
 * whose presence party is `client` reaches here — and the "is it a Case" guard.
 *
 * ⚠ D5.9 — THE EXPERT-WHO-IS-ALSO-A-CLIENT-MEMBER GUARD. A delivering expert who is also a member of
 * the client company resolves to the CLIENT side, so a guest THEY invite would be `party = client` and
 * would convert a floor no-show into a `held` bill for the client. When the guest's `invited_by_id` IS
 * the delivering expert's user id, this returns `expert_invited_guest` and opens NOTHING (the caller logs
 * a warn). The same guard is re-applied post-hoc by the terminal path, so the backstop cannot bill what
 * admission deliberately did not. RESIDUAL (documented in Amendment 7 §E): an agency owner/admin of the
 * delivering agency who is also a client member is not guarded.
 *
 * ⚠ THE OPEN CAN THROW (`ExpertProfileNotFoundError`, a database rejection) and this function does not
 * catch it: the caller's contract is that a join is never failed, so IT catches.
 */
export async function openSessionOnBehalfOfBooker(input: {
  readonly meetingId: string;
  readonly openedBy: 'guest';
  readonly meetingGuestId: string;
  /** The guest row's `invited_by_id` — `null` for a link guest (never reaches here). */
  readonly guestInvitedById: string | null;
}): Promise<OpenSessionOnBehalfResult> {
  const { meetingId, meetingGuestId, guestInvitedById } = input;

  const resolved = await resolveOnBehalfOpenInput({
    meetingId,
    openedBy: input.openedBy,
    meetingGuestId,
    trigger: 'guest_admission',
    // A guest's admission is not yet an attended call: a case closed before the start is not billed.
    attended: false,
    guard: async (subject) => {
      if (guestInvitedById === null) {
        return undefined;
      }
      const expert = await expertsRepository.findUserIdByProfileId(subject.expertProfileId);
      return expert?.user.id === guestInvitedById ? 'expert_invited_guest' : undefined;
    },
  });
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, companyId: resolved.companyId };
  }

  const opened = await creditSessionsRepository.open(resolved.open);
  if (opened.ok) {
    return { ok: true, sessionId: opened.session.id, toleratedGates: opened.toleratedGates };
  }
  if (
    opened.code === 'meeting_session_exists' ||
    opened.code === 'session_in_progress' ||
    opened.code === 'expert_rate_missing'
  ) {
    return { ok: false, code: opened.code, companyId: resolved.subject.companyId };
  }
  // `account_hold` / `settlement_pending` / `insufficient_no_mandate` are the GATED open's refusals;
  // the overdraft-tolerant policy never returns them. Reaching here is a programming error.
  log.error(
    { meetingId, code: opened.code },
    'A tolerant on-behalf open returned a gated refusal — unreachable under the overdraft-tolerant policy'
  );
  throw new Error(`on-behalf open returned a gated refusal: ${opened.code}`);
}
