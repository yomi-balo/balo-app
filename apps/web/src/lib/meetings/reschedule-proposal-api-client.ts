import 'server-only';

import {
  postBaloApiJson,
  readInstant,
  readString,
  type BaloApiResult,
} from '@/lib/api/balo-api-client';

/**
 * BAL-411 — the SERVER-ONLY web→api client for the four reschedule-proposal routes:
 * propose / withdraw (expert, engagement axis) and accept / decline (client, membership axis).
 *
 * MODELLED ON `reschedule-api-client.ts`'s `postRescheduleMeeting` — same authentication posture
 * (a single `requireAuth`-gated route, the viewer's WorkOS Bearer resolved server-side), but four
 * distinct response shapes each need their own parse. Fix round 1 item 9 — the fetch/auth/
 * error-mapping shape itself is no longer copied here; it is `postBaloApiJson` in
 * `lib/api/balo-api-client.ts`, shared with `lib/booking/booking-api-client.ts`. This module
 * keeps only its four `parse*Response` functions and route paths.
 *
 * ⚠ NOTHING HERE THROWS. Every transport error and every non-2xx resolves to a typed failure.
 * ⚠ NOTHING HERE INTERPRETS AN ERROR BODY BEYOND ITS `error` LITERAL.
 */

export type RescheduleProposalApiResult<T> = BaloApiResult<T>;

/** Thin wrapper over the shared `postBaloApiJson` — this module's own log label. */
async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  parse: (parsed: Record<string, unknown>) => T | null
): Promise<RescheduleProposalApiResult<T>> {
  return postBaloApiJson(path, body, parse, 'Reschedule proposal');
}

// ── propose ──────────────────────────────────────────────────────────────────────────────

export interface ProposeRescheduleOption {
  optionId: string;
  scheduledStart: string;
  scheduledEnd: string;
  position: number;
}

export interface ProposeRescheduleResponse {
  proposalId: string;
  meetingId: string;
  expiresAtIso: string;
  options: ProposeRescheduleOption[];
}

function parseProposeResponse(parsed: Record<string, unknown>): ProposeRescheduleResponse | null {
  const proposalId = readString(parsed, 'proposalId');
  const meetingId = readString(parsed, 'meetingId');
  const expiresAtIso = readInstant(parsed, 'expiresAtIso');
  const rawOptions = parsed['options'];
  if (
    proposalId === undefined ||
    meetingId === undefined ||
    expiresAtIso === undefined ||
    !Array.isArray(rawOptions)
  ) {
    return null;
  }
  const options: ProposeRescheduleOption[] = [];
  for (const raw of rawOptions) {
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const optionId = readString(record, 'optionId');
    const scheduledStart = readInstant(record, 'scheduledStart');
    const scheduledEnd = readInstant(record, 'scheduledEnd');
    const position = record['position'];
    if (
      optionId === undefined ||
      scheduledStart === undefined ||
      scheduledEnd === undefined ||
      typeof position !== 'number'
    ) {
      return null;
    }
    options.push({ optionId, scheduledStart, scheduledEnd, position });
  }
  return { proposalId, meetingId, expiresAtIso, options };
}

/** `POST /meetings/:meetingId/reschedule-proposals` — the EXPERT proposes up to 3 alternatives. */
export async function postProposeReschedule(
  meetingId: string,
  input: { options: readonly { scheduledStart: string }[] }
): Promise<RescheduleProposalApiResult<ProposeRescheduleResponse>> {
  return postJson(`/meetings/${meetingId}/reschedule-proposals`, input, parseProposeResponse);
}

// ── withdraw ─────────────────────────────────────────────────────────────────────────────

export interface WithdrawRescheduleProposalResponse {
  proposalId: string;
  status: 'withdrawn';
}

function parseWithdrawResponse(
  parsed: Record<string, unknown>
): WithdrawRescheduleProposalResponse | null {
  const proposalId = readString(parsed, 'proposalId');
  if (proposalId === undefined || parsed['status'] !== 'withdrawn') return null;
  return { proposalId, status: 'withdrawn' };
}

/** `POST /meetings/:meetingId/reschedule-proposals/:proposalId/withdraw` — the EXPERT retracts. */
export async function postWithdrawRescheduleProposal(
  meetingId: string,
  proposalId: string
): Promise<RescheduleProposalApiResult<WithdrawRescheduleProposalResponse>> {
  return postJson(
    `/meetings/${meetingId}/reschedule-proposals/${proposalId}/withdraw`,
    {},
    parseWithdrawResponse
  );
}

// ── accept ───────────────────────────────────────────────────────────────────────────────

export interface AcceptRescheduleProposalResponse {
  proposalId: string;
  meetingId: string;
  /** The COMMITTED window — the server's values, never the client's submitted slot. */
  scheduledStart: string;
  scheduledEnd: string;
  previousScheduledStart: string;
  previousScheduledEnd: string;
  /** The `meeting.rescheduled` audit row id — the caller's `booking.rescheduled` dedup key. */
  rescheduleAuditId?: string;
}

function parseAcceptResponse(
  parsed: Record<string, unknown>
): AcceptRescheduleProposalResponse | null {
  const proposalId = readString(parsed, 'proposalId');
  const meetingId = readString(parsed, 'meetingId');
  const scheduledStart = readInstant(parsed, 'scheduledStart');
  const scheduledEnd = readInstant(parsed, 'scheduledEnd');
  const previousScheduledStart = readInstant(parsed, 'previousScheduledStart');
  const previousScheduledEnd = readInstant(parsed, 'previousScheduledEnd');
  const rescheduleAuditId = readString(parsed, 'rescheduleAuditId');
  if (
    proposalId === undefined ||
    meetingId === undefined ||
    scheduledStart === undefined ||
    scheduledEnd === undefined ||
    previousScheduledStart === undefined ||
    previousScheduledEnd === undefined
  ) {
    return null;
  }
  return {
    proposalId,
    meetingId,
    scheduledStart,
    scheduledEnd,
    previousScheduledStart,
    previousScheduledEnd,
    ...(rescheduleAuditId === undefined ? {} : { rescheduleAuditId }),
  };
}

/** `POST /meetings/:meetingId/reschedule-proposals/:proposalId/accept` — the CLIENT accepts. */
export async function postAcceptRescheduleProposal(
  meetingId: string,
  proposalId: string,
  input: { optionId: string }
): Promise<RescheduleProposalApiResult<AcceptRescheduleProposalResponse>> {
  return postJson(
    `/meetings/${meetingId}/reschedule-proposals/${proposalId}/accept`,
    input,
    parseAcceptResponse
  );
}

// ── decline ──────────────────────────────────────────────────────────────────────────────

export interface DeclineRescheduleProposalResponse {
  proposalId: string;
  status: 'declined';
}

function parseDeclineResponse(
  parsed: Record<string, unknown>
): DeclineRescheduleProposalResponse | null {
  const proposalId = readString(parsed, 'proposalId');
  if (proposalId === undefined || parsed['status'] !== 'declined') return null;
  return { proposalId, status: 'declined' };
}

/** `POST /meetings/:meetingId/reschedule-proposals/:proposalId/decline` — the CLIENT declines. */
export async function postDeclineRescheduleProposal(
  meetingId: string,
  proposalId: string
): Promise<RescheduleProposalApiResult<DeclineRescheduleProposalResponse>> {
  return postJson(
    `/meetings/${meetingId}/reschedule-proposals/${proposalId}/decline`,
    {},
    parseDeclineResponse
  );
}
