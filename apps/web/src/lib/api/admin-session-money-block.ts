import 'server-only';

import type { AdminMoneyBlock } from '@balo/shared/credit';
import { callSessionApi } from '@/lib/credit/api-client';
import { log } from '@/lib/logging';

/**
 * BAL-551 — server-only web→api fetch of the ADMIN (margin-bearing) money block, for the
 * Lookup drill-in's Money section. Points `callSessionApi` at
 * `GET /admin/sessions/:id/money-block` (`apps/api/src/routes/sessions/index.ts:307-309`),
 * which self-asserts `MANAGE_PLATFORM_FEES` and returns the full-economics payload.
 *
 * ⚠ NOT the repository path. `creditSessionsRepository.findForAdminView` + `toAdminMoneyBlock`
 * skip `resolveAdminMoneyBlock`'s capability self-assert — going through them here would fork
 * the authorization surface into two places that decide the same fact. The HTTP hop keeps one.
 *
 * ⚠ NOT `resolveSessionLens` — that resolver has no admin arm (`{lens:'client'}|{lens:'expert'}
 * |{ok:false}`) and staff would 404 through it.
 *
 * The payload TYPE comes from `@balo/shared/credit` — NEVER `@balo/db` (memory
 * `reference_balo_db_client_bundle_footgun`).
 *
 * ⚠ Structurally different from the sibling `fetchSessionMoneyBlock`
 * (`apps/web/src/lib/api/session-money-block.ts`), not a jscpd clone: that one collapses every
 * failure to `null`. This one MUST NOT — the Money section has to distinguish a `403`
 * (fee-blind viewer) from "not available", so every outcome is a distinct typed reason.
 */

export type AdminSessionMoneyResult =
  | { readonly ok: true; readonly block: AdminMoneyBlock }
  | { readonly ok: false; readonly reason: 'forbidden' | 'not_found' | 'unavailable' };

export async function fetchAdminSessionMoneyBlock(
  sessionId: string
): Promise<AdminSessionMoneyResult> {
  const result = await callSessionApi<AdminMoneyBlock>(
    `/admin/sessions/${sessionId}/money-block`,
    'GET'
  );

  if (result.ok) {
    return { ok: true, block: result.data };
  }

  if (result.status === 403) {
    // A staff viewer with VIEW_PLATFORM_ADMIN but not MANAGE_PLATFORM_FEES cannot exist today
    // (both are in PLATFORM_STAFF_BUNDLE) — firing means the bundle split shipped or something
    // drifted. log.warn per CLAUDE.md's "recoverable issues / validation anomalies" guidance.
    log.warn('Admin money block denied to a staff viewer', { sessionId });
    return { ok: false, reason: 'forbidden' };
  }

  if (result.status === 404) {
    return { ok: false, reason: 'not_found' };
  }

  // Transport errors (status 0) and 401 are already log.error'd inside callSessionApi's own
  // catch — do not double-log here.
  return { ok: false, reason: 'unavailable' };
}
