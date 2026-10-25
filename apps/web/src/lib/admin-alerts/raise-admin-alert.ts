import 'server-only';

import { adminAlertsRepository, type RaiseAdminAlertInput } from '@balo/db';
import { log } from '@/lib/logging';

/**
 * ADR-1055 — the web twin of the API's best-effort wrapper around
 * `adminAlertsRepository.raise` (`apps/api/src/services/admin-alerts/raise.ts`).
 *
 * ⚠ IT SWALLOWS ITS OWN FAILURE, DELIBERATELY. An alert is a side signal about a user
 * action that has already succeeded; a failure to record it must never turn that action
 * into a failure the user sees. The failure is logged here, so the miss is still on the
 * record.
 *
 * Additive, never a replacement: a call site keeps its own logging and analytics beside
 * this call. Not a `'use server'` module — it is not reachable from the client.
 */
export async function raiseAdminAlert(input: RaiseAdminAlertInput): Promise<void> {
  try {
    await adminAlertsRepository.raise(input);
  } catch (error) {
    log.error('Failed to raise an admin alert', {
      kind: input.kind,
      entityType: input.entityType,
      entityId: input.entityId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}
