import 'server-only';

import { callSessionApi } from '@/lib/credit/api-client';
import { log } from '@/lib/logging';

/**
 * BAL-550 — server-only web→api fetch of `POST /admin/redrive/:kind/:id`
 * (`apps/api/src/routes/admin/index.ts`). Mirrors the `admin-session-money-block.ts` precedent:
 * the identity-carrying Bearer hop, never the internal secret and never a repository read from
 * `apps/web` (this feature never imports `bullmq`/`ioredis` — see
 * `invariants/web-actions-never-import-bullmq.test.ts`).
 *
 * Every outcome maps to a DISTINCT typed reason, never collapsed to `null` — the confirm
 * sheet's toast needs to tell "the row already moved" (`not_redrivable`) apart from "it queued
 * but the job never enqueued" (`enqueue_failed`, which still carries the audit trail id) apart
 * from a bare transport fault (`unavailable`).
 */
export type AdminRedriveKind = 'recording-ingest' | 'transcript-pipeline';

export interface AdminRedriveSuccess {
  kind: AdminRedriveKind;
  entityId: string;
  auditEventId: string;
  jobId: string;
}

export type AdminRedriveResult =
  | { ok: true; result: AdminRedriveSuccess }
  | { ok: false; reason: 'forbidden' | 'not_redrivable' | 'enqueue_failed' | 'unavailable' };

export async function requestAdminRedrive(
  kind: AdminRedriveKind,
  entityId: string
): Promise<AdminRedriveResult> {
  const result = await callSessionApi<AdminRedriveSuccess>(
    `/admin/redrive/${kind}/${entityId}`,
    'POST'
  );

  if (result.ok) {
    return { ok: true, result: result.data };
  }

  if (result.status === 403) {
    log.warn('Admin re-drive denied to a staff viewer', { kind, entityId });
    return { ok: false, reason: 'forbidden' };
  }

  if (result.status === 409) {
    return { ok: false, reason: 'not_redrivable' };
  }

  if (result.status === 502) {
    // The audit row DID commit (the CAS moved the row) even though the enqueue failed — that
    // trail lives server-side (the route's `log.error` + the audit_events row itself), so this
    // hop reports the CATEGORY only; ops does not need the id surfaced through the UI toast.
    return { ok: false, reason: 'enqueue_failed' };
  }

  // Transport errors (status 0), 400 (should never reach a well-formed caller), 401 and 503 are
  // already `log.error`'d inside `callSessionApi`'s own catch or the api's own handler — do not
  // double-log here.
  return { ok: false, reason: 'unavailable' };
}
