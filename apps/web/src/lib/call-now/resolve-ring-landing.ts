import 'server-only';

import { z } from 'zod';
import type { CallRingStatus } from '@balo/shared/meetings';
import { callSessionApi } from '@/lib/credit/api-client';
import { log } from '@/lib/logging';
import { ringLandingPath } from './ring-landing-path';

const FALLBACK_PATH = '/cases';

const ringIdSchema = z.uuid();

const RING_STATUSES: ReadonlySet<string> = new Set<CallRingStatus>([
  'ringing',
  'connected',
  'unanswered',
  'declined',
  'stopped',
]);

interface RingReadBody {
  readonly status: CallRingStatus;
  readonly meetingId: string;
  readonly engagementId: string;
  readonly expiresAt: string;
}

function isRingStatus(value: unknown): value is CallRingStatus {
  return typeof value === 'string' && RING_STATUSES.has(value);
}

function readRing(body: unknown): RingReadBody | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { status, meetingId, engagementId, expiresAt } = body as Record<string, unknown>;
  if (
    !isRingStatus(status) ||
    typeof meetingId !== 'string' ||
    typeof engagementId !== 'string' ||
    typeof expiresAt !== 'string'
  ) {
    return undefined;
  }
  return { status, meetingId, engagementId, expiresAt };
}

/**
 * The path an SMS "call now" link resolves to for the signed-in viewer. The ring read is
 * party-scoped by the api, so a ring that is unknown or belongs to someone else is the same 404.
 * A `ringId` that is not a UUID never reaches the api path. Every failure lands on the case list rather than an error page: the link was clicked from a
 * text message and a dead end there helps nobody.
 */
export async function resolveRingLandingPath(ringId: string): Promise<string> {
  if (!ringIdSchema.safeParse(ringId).success) return FALLBACK_PATH;

  const result = await callSessionApi<unknown>(`/call-now/rings/${ringId}`, 'GET');

  if (!result.ok) {
    if (result.status !== 404) {
      log.warn('Call now SMS link could not read the ring', { ringId, status: result.status });
    }
    return FALLBACK_PATH;
  }

  const ring = readRing(result.data);
  if (ring === undefined) {
    log.warn('Call now SMS link read an unexpected ring body', { ringId, status: result.status });
    return FALLBACK_PATH;
  }

  return ringLandingPath(ring, new Date());
}
