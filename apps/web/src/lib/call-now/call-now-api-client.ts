import 'server-only';

import type { CallNowPresence } from '@balo/analytics/events';
import type {
  CallRingPlacement,
  CallRingReach,
  CallRingStatus,
  MemberJoinResponse,
} from '@balo/shared/meetings';
import {
  getBaloApiJson,
  postBaloApiJson,
  readInstant,
  readString,
  type BaloApiResult,
} from '@/lib/api/balo-api-client';
import type { CallNowRingRead, CallNowStartRead, CallNowViewRead } from './call-now-types';

/**
 * The server-only web→api hop for Call now (BAL-649/650/652), on the shared `balo-api-client`
 * shape. Nothing here throws; every transport error and non-2xx is a typed failure.
 *
 * ⚠ SKEW-TOLERANT PARSE. Vercel can be live before Railway, so a field the newer api adds is
 * defaulted when absent: `calleeOnline` → `false`, `calleeTimeZone` → `null`, `reachedBy` →
 * `'app'`, `attemptId` → `null`, `calleePresenceAtStart` → `'offline'`. A body missing a field the
 * api has always sent is malformed.
 */

const RING_STATUSES: ReadonlySet<string> = new Set<CallRingStatus>([
  'ringing',
  'connected',
  'unanswered',
  'declined',
  'stopped',
]);

const RING_PLACEMENTS: ReadonlySet<string> = new Set<CallRingPlacement>([
  'new_meeting',
  'in_place',
]);

function isRingStatus(value: unknown): value is CallRingStatus {
  return typeof value === 'string' && RING_STATUSES.has(value);
}

function isRingPlacement(value: unknown): value is CallRingPlacement {
  return typeof value === 'string' && RING_PLACEMENTS.has(value);
}

function readBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readPresence(body: Record<string, unknown>): CallNowPresence {
  return body.calleePresenceAtStart === 'online' ? 'online' : 'offline';
}

function readReachedBy(body: Record<string, unknown>): CallRingReach {
  return body.reachedBy === 'sms' ? 'sms' : 'app';
}

function readInPlaceCandidate(
  body: Record<string, unknown>
): CallNowViewRead['inPlaceCandidate'] | undefined {
  const raw = body.inPlaceCandidate;
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return undefined;
  const candidate = raw as Record<string, unknown>;
  const meetingId = readString(candidate, 'meetingId');
  const scheduledStartIso = readInstant(candidate, 'scheduledStart');
  if (meetingId === undefined || scheduledStartIso === undefined) return undefined;
  return { meetingId, scheduledStartIso };
}

/** Parse a `GET /cases/:id/call-now` body. `null` when a field the api always sends is wrong. */
export function parseCallNowView(body: Record<string, unknown>): CallNowViewRead | null {
  const canCallNow = readBoolean(body, 'canCallNow');
  const inPlaceCandidate = readInPlaceCandidate(body);
  if (canCallNow === undefined || inPlaceCandidate === undefined) return null;
  const { reason } = body;
  if (reason !== null && reason !== 'busy' && reason !== 'outside_hours') return null;
  return {
    canCallNow,
    reason,
    calleeOnline: readBoolean(body, 'calleeOnline') ?? false,
    calleeTimeZone: readString(body, 'calleeTimeZone') ?? null,
    inPlaceCandidate,
  };
}

/**
 * Parse a ring read body: the single reader for `GET /call-now/rings/:id`, shared with the SMS
 * landing so the two can never disagree about the wire shape.
 */
export function parseRingRead(body: unknown): CallNowRingRead | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const { status, placement, role } = record;
  const ringId = readString(record, 'ringId');
  const meetingId = readString(record, 'meetingId');
  const engagementId = readString(record, 'engagementId');
  const expiresAt = readString(record, 'expiresAt');
  const awaitsAnswer = readBoolean(record, 'awaitsAnswer');
  const meetingEnded = readBoolean(record, 'meetingEnded');
  if (
    !isRingStatus(status) ||
    ringId === undefined ||
    meetingId === undefined ||
    engagementId === undefined ||
    expiresAt === undefined ||
    awaitsAnswer === undefined ||
    meetingEnded === undefined
  ) {
    return undefined;
  }
  return {
    ringId,
    meetingId,
    engagementId,
    status,
    placement: isRingPlacement(placement) ? placement : null,
    expiresAt,
    role: role === 'caller' || role === 'callee' ? role : null,
    awaitsAnswer,
    meetingEnded,
    reachedBy: readReachedBy(record),
    attemptId: readString(record, 'attemptId') ?? null,
    calleePresenceAtStart: readPresence(record),
  };
}

function parseStart(body: Record<string, unknown>): CallNowStartRead | null {
  const ringId = readString(body, 'ringId');
  const meetingId = readString(body, 'meetingId');
  const expiresAt = readString(body, 'expiresAt');
  const { placement } = body;
  if (
    ringId === undefined ||
    meetingId === undefined ||
    expiresAt === undefined ||
    !isRingPlacement(placement)
  ) {
    return null;
  }
  return { ringId, meetingId, placement, expiresAt };
}

function parseStatusBody(body: Record<string, unknown>): { status: CallRingStatus } | null {
  const { status } = body;
  return isRingStatus(status) ? { status } : null;
}

function parseJoinGrant(body: Record<string, unknown>): MemberJoinResponse | null {
  const hasGrant =
    typeof body.roomUrl === 'string' &&
    typeof body.token === 'string' &&
    typeof body.isOwner === 'boolean';
  return hasGrant ? (body as unknown as MemberJoinResponse) : null;
}

function ringPath(ringId: string, action?: 'stop' | 'answer'): string {
  const base = `/call-now/rings/${encodeURIComponent(ringId)}`;
  return action === undefined ? base : `${base}/${action}`;
}

export function getCallNowView(engagementId: string): Promise<BaloApiResult<CallNowViewRead>> {
  return getBaloApiJson(
    `/cases/${encodeURIComponent(engagementId)}/call-now`,
    parseCallNowView,
    'Call now view'
  );
}

/**
 * Start a call. `attemptId` rides as a QUERY parameter, never in the body: the api's body schema is
 * strict, so a new web build calling a not-yet-deployed api would 400 every start if it were a
 * body field, whereas an unknown query parameter is ignored.
 */
export function postStartCallNow(
  engagementId: string,
  options: { inPlaceOfMeetingId?: string; attemptId: string }
): Promise<BaloApiResult<CallNowStartRead>> {
  const { inPlaceOfMeetingId, attemptId } = options;
  const body = inPlaceOfMeetingId === undefined ? {} : { inPlaceOfMeetingId };
  return postBaloApiJson(
    `/cases/${encodeURIComponent(engagementId)}/call-now?attemptId=${encodeURIComponent(attemptId)}`,
    body,
    parseStart,
    'Call now start'
  );
}

export function getCallNowRing(ringId: string): Promise<BaloApiResult<CallNowRingRead>> {
  return getBaloApiJson(
    ringPath(ringId),
    (body) => parseRingRead(body) ?? null,
    'Call now ring read'
  );
}

export function postStopRing(ringId: string): Promise<BaloApiResult<{ status: CallRingStatus }>> {
  return postBaloApiJson(ringPath(ringId, 'stop'), {}, parseStatusBody, 'Call now stop');
}

export function postAnswerRing(ringId: string): Promise<BaloApiResult<MemberJoinResponse>> {
  return postBaloApiJson(ringPath(ringId, 'answer'), {}, parseJoinGrant, 'Call now answer');
}
