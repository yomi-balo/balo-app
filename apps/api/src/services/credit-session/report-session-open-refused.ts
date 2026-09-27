/**
 * BAL-466 (F7/F8, G5) → BAL-474 (ADR-1040 Amendment 7 §D, D7.6) — THE ONE WRITER of the
 * `session.open_refused` admin alert and its analytics, MOVED OUT OF `join-meeting.ts` because it now
 * has THREE openers, not one: a client member's admission, a client-side guest's admission, and the
 * SESSIONLESS TERMINAL PATH (`settle-sessionless-case-meeting.ts`, incl. the durability backstop).
 * `admin-alert-kinds-have-exactly-one-writer.test.ts` pins that the kind literal appears in exactly
 * one raise-capable file — this one.
 *
 * ⚠⚠ WHAT "REFUSED" NOW MEANS (D7.6). Every presence-seam open is overdraft-tolerant, and the terminal
 * path opens and settles any billable sessionless Case meeting when it ends. So a refusal AT
 * ADMISSION is no longer "an unbilled consultation" unless the terminal path CANNOT recover it. The
 * reasons split into two data-driven maps, and only the second one pages an operator:
 *
 *   · {@link ADMISSION_OPEN_DEFERRED_MESSAGES} — RECOVERABLE. The terminal path opens and settles the
 *     session, so admission logs the truth (`warn`) + analytics with `recovered_by_terminal_path:
 *     true`, and raises NO admin alert.
 *   · {@link SESSION_OPEN_REFUSED_MESSAGES} — NOT recoverable (or the terminal path's OWN refusal).
 *     `error` + Sentry + analytics + an admin alert.
 *
 * ⚠ `walletId` IS BEST-EFFORT — a diagnostic read (`creditWalletsRepository.findByCompanyId`) on an
 * already-rare error path, never load-bearing for the refusal, which has already happened. A lookup
 * failure (or an unresolved company) degrades to `null`: an alarm about a refusal must never itself
 * risk failing the join or the sweep.
 *
 * ⚠ SENTRY: one of several direct `Sentry.captureException` calls (see also
 * `provision-meeting.ts`, `publish-calendar-invites.ts`) — a plain SDK import and call, no wrapper.
 * A caught, non-throwing condition, so the error is constructed here solely to carry a message and
 * stack into Sentry's grouping.
 */
import * as Sentry from '@sentry/node';
import { creditWalletsRepository } from '@balo/db';
import { SESSION_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import type { CreditSessionOpenedByLabel } from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';
import { raiseAdminAlert } from '../admin-alerts/raise.js';

const log = createLogger('credit-session');

/**
 * A `session_open_refused` REASON — the analytics union's members. Every member EXCEPT
 * `wallet_busy`, `booker_unattributable` and `retry_exhausted` is verbatim an
 * `OpenSessionServiceErrorCode`; those three are synthetic (`wallet_busy` stands in for
 * `session_in_progress`'s DIFFERENT-meeting shape; the other two are the terminal path's own).
 * `insufficient_no_mandate`, `account_hold` and `settlement_pending` are GONE: the presence seam
 * tolerates all three.
 */
export type SessionOpenRefusedReason =
  | 'wallet_busy'
  | 'expert_rate_missing'
  | 'wallet_missing'
  | 'forbidden'
  | 'meeting_not_bookable'
  | 'booker_unattributable'
  | 'retry_exhausted';

/** The reasons the terminal path RECOVERS — admission reports them truthfully and does not page. */
export type AdmissionDeferredReason = Extract<
  SessionOpenRefusedReason,
  'wallet_busy' | 'forbidden' | 'wallet_missing' | 'meeting_not_bookable'
>;

/** The reasons that page an operator (at admission, or on the terminal path's own refusal). */
export type AlertingRefusalReason = Exclude<
  SessionOpenRefusedReason,
  'wallet_busy' | 'forbidden' | 'wallet_missing'
>;

/** Who tried to open — the fields every report carries. */
export interface OpenRefusalFields {
  readonly meetingId: string;
  /** `null` when the terminal path could not resolve the meeting's billing company at all. */
  readonly companyId: string | null;
  /** `null` on the system path (no acting user) and when a guest opened. */
  readonly userId: string | null;
  readonly openedBy: CreditSessionOpenedByLabel;
}

/**
 * ONE human-legible message per RECOVERABLE reason, DATA-DRIVEN rather than a branching chain
 * (CLAUDE.md: data-driven over repetitive for a fixed set of same-shape values). The stem is shared:
 * whatever the gate, the terminal path opens and settles the session when the meeting ends.
 */
export const ADMISSION_OPEN_DEFERRED_MESSAGES: Readonly<Record<AdmissionDeferredReason, string>> = {
  wallet_busy:
    "Credit session not opened at admission — this company wallet already has a live session on another meeting; the meeting's terminal path opens and settles it (ADR-1040 Amendment 7 §D)",
  forbidden:
    "Credit session not opened at admission — the joining member lacks CONSUME_CREDITS on the billing company; the meeting's terminal path opens and settles it on behalf of the booker (ADR-1040 Amendment 7 §D)",
  wallet_missing:
    "Credit session not opened at admission — the company has no credit wallet yet; the meeting's terminal path provisions it, then opens and settles the session (ADR-1040 Amendment 7 §D)",
  meeting_not_bookable:
    "Credit session not opened at admission — the meeting did not resolve to an active case engagement; the meeting's terminal path re-checks coherence only and settles it if the engagement exists (ADR-1040 Amendment 7 §D)",
};

/**
 * The message for an OPEN THAT THREW at admission — an exception, not a refusal. The terminal path
 * opens and settles the session, so this replaces the pre-BAL-474 "the call proceeds unbilled".
 */
export const ADMISSION_OPEN_THREW_MSG =
  "Credit session open threw at admission — no session opened; the meeting's terminal path opens and settles it (ADR-1040 Amendment 7 §D)";

/**
 * ONE message per ALERTING reason, per stage. `admission` holds the one reason admission still pages
 * for; `terminal` holds every reason the terminal path itself can refuse (or exhaust) with — every
 * one of them ends in an unbilled consultation and an unpaid expert.
 */
export const SESSION_OPEN_REFUSED_MESSAGES = {
  admission: {
    expert_rate_missing:
      'Credit session refused at admission — the delivering expert has no rate set; if a rate is set before this meeting ends, its terminal path bills it, otherwise that path refuses it and alarms again',
  },
  terminal: {
    expert_rate_missing:
      'Credit session refused when the meeting ended — the delivering expert has no rate set; this consultation is unbilled and the expert is unpaid',
    meeting_not_bookable:
      'Credit session refused when the meeting ended — the meeting did not resolve to a billable case engagement; this consultation is unbilled and the expert is unpaid',
    booker_unattributable:
      'Credit session refused — the meeting has no attributable booker (an unattributed meeting.booked row); no session was opened on their behalf, this consultation is unbilled and the expert is unpaid',
    retry_exhausted:
      'Credit session refused — the sessionless Case meeting could not be opened and settled within the retry window; this consultation is unbilled and the expert is unpaid',
  },
} as const satisfies {
  admission: Partial<Record<AlertingRefusalReason, string>>;
  terminal: Record<AlertingRefusalReason, string>;
};

/** The alert title, by opener — a system open is the TERMINAL path; a member / guest is ADMISSION. */
const ALERT_TITLES: Readonly<Record<CreditSessionOpenedByLabel, string>> = {
  client: 'Credit session refused at admission',
  guest: 'Credit session refused at guest admission',
  system: 'Credit session refused when the meeting ended',
};

/** Best-effort diagnostic wallet read — a failure (or an unresolved company) degrades to `null`. */
async function readWalletIdBestEffort(companyId: string | null): Promise<string | null> {
  if (companyId === null) {
    return null;
  }
  try {
    const wallet = await creditWalletsRepository.findByCompanyId(companyId);
    return wallet?.id ?? null;
  } catch {
    return null; // best-effort — see the module docblock.
  }
}

/** The analytics event, identical for a recoverable log-only report and an alerting one. */
function trackRefusal(
  reason: SessionOpenRefusedReason,
  fields: OpenRefusalFields,
  walletId: string | null,
  recoveredByTerminalPath: boolean
): void {
  trackServer(SESSION_SERVER_EVENTS.SESSION_OPEN_REFUSED, {
    meeting_id: fields.meetingId,
    company_id: fields.companyId,
    wallet_id: walletId,
    reason,
    opened_by: fields.openedBy,
    recovered_by_terminal_path: recoveredByTerminalPath,
    distinct_id: fields.companyId ?? fields.meetingId,
  });
}

/**
 * BAL-474 (D7.6) — the ADMISSION-seam report for a recoverable reason: a truthful `warn` (no admin
 * alert) plus analytics with `recovered_by_terminal_path: true`. The terminal path opens and settles
 * the session, so the consultation is NOT lost.
 */
export async function reportAdmissionOpenDeferred(
  reason: AdmissionDeferredReason,
  fields: OpenRefusalFields
): Promise<void> {
  const walletId = await readWalletIdBestEffort(fields.companyId);
  log.warn(
    {
      meetingId: fields.meetingId,
      companyId: fields.companyId,
      walletId,
      userId: fields.userId,
      openedBy: fields.openedBy,
      reason,
    },
    ADMISSION_OPEN_DEFERRED_MESSAGES[reason]
  );
  trackRefusal(reason, fields, walletId, true);
}

/**
 * BAL-466 (F7/F8, review fix round) → BAL-474 — THE SHARED ALARM for a refused open that loses (or
 * risks losing) money. Every alerting caller shares ONE implementation so the log shape, the Sentry
 * context, the analytics payload and the alert cannot drift between reasons or openers.
 *
 * The stage is derived from `fields.openedBy`: `system` is the terminal path. A reason admission
 * still pages for (`expert_rate_missing`) has its own admission message; every other alerting reason
 * is the terminal path's.
 */
export async function reportSessionOpenRefused(
  reason: AlertingRefusalReason,
  fields: OpenRefusalFields
): Promise<void> {
  const { meetingId, companyId, userId, openedBy } = fields;
  const walletId = await readWalletIdBestEffort(companyId);

  const admissionMessages: Partial<Record<AlertingRefusalReason, string>> =
    SESSION_OPEN_REFUSED_MESSAGES.admission;
  const message =
    (openedBy === 'system' ? undefined : admissionMessages[reason]) ??
    SESSION_OPEN_REFUSED_MESSAGES.terminal[reason];

  log.error({ meetingId, companyId, walletId, userId, openedBy, reason }, message);
  Sentry.captureException(new Error(message), {
    extra: { meetingId, companyId, walletId, reason, openedBy },
  });
  trackRefusal(reason, fields, walletId, false);

  // BAL-548 / ADR-1055 — ADDITIVE to the log.error / Sentry / trackServer calls above, never a
  // replacement. `entity_id` is the MEETING, not a session — there IS no session row, that is the
  // whole point of the refusal, so the meeting is the only real id in hand; company and wallet ride
  // in `facts`. Best-effort: `raiseAdminAlert` swallows its own failure, matching this whole
  // function's "an alarm about a refusal must never itself risk failing the join" posture.
  await raiseAdminAlert({
    kind: 'session.open_refused',
    entityType: 'meeting',
    entityId: meetingId,
    detail: {
      title: ALERT_TITLES[openedBy],
      entityLabel: `Meeting ${meetingId}`,
      evidence: message,
      facts: [
        ['Meeting', meetingId],
        ['Company', companyId ?? 'unresolved'],
        ['Wallet', walletId ?? 'unknown'],
        ['Reason', reason],
        ['Opened by', openedBy],
      ],
    },
  });
}

/**
 * The admission seam's single entry for a non-ok open: routes a reason to the LOG-ONLY map or the
 * ALERTING one. A reason the terminal path recovers never pages; `expert_rate_missing` — the one
 * admission reason no terminal path recovers unless the rate is set before the meeting ends — does.
 */
export async function reportAdmissionOpenOutcome(
  reason: AdmissionDeferredReason | 'expert_rate_missing',
  fields: OpenRefusalFields
): Promise<void> {
  if (reason === 'expert_rate_missing') {
    await reportSessionOpenRefused(reason, fields);
    return;
  }
  await reportAdmissionOpenDeferred(reason, fields);
}
