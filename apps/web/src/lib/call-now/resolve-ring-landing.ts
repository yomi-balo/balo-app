import 'server-only';

import { z } from 'zod';
import { callSessionApi } from '@/lib/credit/api-client';
import { log } from '@/lib/logging';
import { parseRingRead } from './call-now-api-client';
import { ringLandingPath } from './ring-landing-path';

const FALLBACK_PATH = '/cases';

const ringIdSchema = z.uuid();

/** Whether a path segment is a well-formed ring id, the only shape the api path may carry. */
export function isRingId(value: string): boolean {
  return ringIdSchema.safeParse(value).success;
}

/**
 * The path an SMS "call now" link resolves to for the signed-in viewer. The ring read is
 * party-scoped by the api, so a ring that is unknown or belongs to someone else is the same 404.
 * A `ringId` that is not a UUID never reaches the api path. Every failure lands on the case list rather than an error page: the link was clicked from a
 * text message and a dead end there helps nobody.
 */
export async function resolveRingLandingPath(ringId: string): Promise<string> {
  if (!isRingId(ringId)) return FALLBACK_PATH;

  const result = await callSessionApi<unknown>(`/call-now/rings/${ringId}`, 'GET');

  if (!result.ok) {
    if (result.status !== 404) {
      log.warn('Call now SMS link could not read the ring', { ringId, status: result.status });
    }
    return FALLBACK_PATH;
  }

  const ring = parseRingRead(result.data);
  if (ring === undefined) {
    log.warn('Call now SMS link read an unexpected ring body', { ringId, status: result.status });
    return FALLBACK_PATH;
  }

  return ringLandingPath(ring, new Date());
}
