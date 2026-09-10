import { adminAlertsRepository, type RaiseAdminAlertInput } from '@balo/db';
import { createLogger } from '@balo/shared/logging';

const logger = createLogger('admin-alerts-raise');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * BAL-548 / ADR-1055 — THE ONE best-effort wrapper around `adminAlertsRepository.raise`.
 *
 * ⚠ IT SWALLOWS ITS OWN FAILURE, DELIBERATELY. Every call site is an ALARM PATH: a refused
 * consultation admission, a failed enqueue, a stuck reload. An alert about a failure must
 * never itself turn that failure into a second, worse one —
 * `apps/api/src/services/meetings/join-meeting.ts`'s `reportSessionOpenRefused` docblock
 * states the same rule for its own diagnostic wallet read ("an alarm about a refusal must
 * never itself risk failing the join").
 *
 * ⚠ ADDITIVE, NEVER A REPLACEMENT (ADR-1055). Every call site keeps its existing
 * `log.error` / `log.warn` / Sentry / `trackServer` call — this sits BESIDE it, never in place
 * of it. If this call fails, the original diagnostic signal is still on the record right next
 * to the failure this function logs below.
 */
export async function raiseAdminAlert(input: RaiseAdminAlertInput): Promise<void> {
  try {
    await adminAlertsRepository.raise(input);
  } catch (error) {
    logger.error(
      {
        kind: input.kind,
        entityType: input.entityType,
        entityId: input.entityId,
        error: errorMessage(error),
      },
      'Failed to raise an admin alert — the underlying condition is still recorded in the log line beside this one'
    );
  }
}
