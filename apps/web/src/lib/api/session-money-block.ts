import 'server-only';

import type { SessionMoneyBlock } from '@balo/shared/credit';
import { callSessionApi } from '@/lib/credit/api-client';

/**
 * BAL-399 — server-only web→api fetch of the recap money block. The api route
 * (`GET /sessions/:id/money-block`) resolves the lens (company member → CLIENT, the session's
 * expert → EXPERT) and returns the fee-concealed payload; this client just forwards the viewer's
 * WorkOS Bearer token (via `callSessionApi`) and returns the typed block.
 *
 * The payload TYPE comes from `@balo/shared/credit` — NEVER `@balo/db` (memory
 * `reference_balo_db_client_bundle_footgun`): a client component may import this type without
 * dragging the postgres driver into the bundle.
 */
export type { SessionMoneyBlock };

/** Fetch the money block for a session; `null` on any non-2xx / transport error (render the fallback). */
export async function fetchSessionMoneyBlock(sessionId: string): Promise<SessionMoneyBlock | null> {
  const result = await callSessionApi<SessionMoneyBlock>(
    `/sessions/${sessionId}/money-block`,
    'GET'
  );
  return result.ok ? result.data : null;
}
