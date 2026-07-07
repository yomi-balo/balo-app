import 'server-only';

import { trackServerAndFlush, PARTY_DOMAIN_SERVER_EVENTS } from '@/lib/analytics/server';
import type { DomainCaptureResult } from '@balo/db';

/**
 * Emit the domain auto-capture analytics for a `createWithWorkspace` result.
 * `@balo/db` never emits — the capture repo returns a structured result and this
 * runs in the web caller AFTER the transaction commits (post-commit by
 * construction: `createWithWorkspace` resolves only once its tx has committed).
 *
 * Emits ONLY on `captured` and `skipped`; `already_owned` and `not_applicable`
 * are silent (an idempotent retry / a non-corporate signup are not notable).
 */
export function emitDomainCapture(result: DomainCaptureResult, userId: string): void {
  if (result.outcome === 'captured') {
    trackServerAndFlush(PARTY_DOMAIN_SERVER_EVENTS.CAPTURED, {
      party_type: result.partyType,
      source: result.source,
      distinct_id: userId,
    });
  } else if (result.outcome === 'skipped') {
    trackServerAndFlush(PARTY_DOMAIN_SERVER_EVENTS.CAPTURE_SKIPPED, {
      reason: result.reason,
      distinct_id: userId,
    });
  }
}
