import 'server-only';

import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';
import { trackServerAndFlush, ADMIN_COMPANY_SERVER_EVENTS } from '@/lib/analytics/server';
import type {
  CompanyDetailsActionResult,
  CompanyDetailsFailureCode,
} from '../../_lib/company-details-types';

// ── Copy ───────────────────────────────────────────────────────────────────────────────

export const INVALID_REQUEST = "That request wasn't valid. Refresh and try again.";
export const SAVE_FAILED_ERROR = "Couldn't save that change. Nothing was changed — try again.";
export const INDUSTRY_UNAVAILABLE_ERROR = "That industry isn't available any more. Pick another.";
export const COMPANY_GONE_ERROR = "We couldn't find that company. It may have been removed.";

export const personalWorkspaceError = (companyName: string): string =>
  `${companyName} is a personal workspace, so its name never appears on reviews.`;

// ── Result builders ────────────────────────────────────────────────────────────────────

export function denied(error: string): CompanyDetailsActionResult {
  return { success: false, error, code: 'denied' };
}

export function failure(
  error: string,
  code?: Exclude<CompanyDetailsFailureCode, 'denied'>
): CompanyDetailsActionResult {
  return code === undefined ? { success: false, error } : { success: false, error, code };
}

export function saveFailed(
  message: string,
  context: Record<string, unknown>,
  error: unknown
): CompanyDetailsActionResult {
  log.error(message, {
    ...context,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return failure(SAVE_FAILED_ERROR);
}

// ── Post-commit side effects ───────────────────────────────────────────────────────────

export type CompanyDetailsChange =
  | { kind: 'industry'; actorUserId: string; companyId: string; cleared: boolean }
  | { kind: 'review_name'; actorUserId: string; companyId: string; hidden: boolean };

function sideEffectSteps(change: CompanyDetailsChange): Array<[string, () => void]> {
  switch (change.kind) {
    case 'industry':
      return [
        [
          'log',
          () =>
            log.info('Company industry set by staff', {
              companyId: change.companyId,
              actorUserId: change.actorUserId,
              cleared: change.cleared,
            }),
        ],
        [
          'analytics',
          () =>
            trackServerAndFlush(ADMIN_COMPANY_SERVER_EVENTS.INDUSTRY_SET, {
              cleared: change.cleared,
              distinct_id: change.actorUserId,
            }),
        ],
        ['revalidate', () => revalidatePath(`/admin/companies/${change.companyId}`)],
      ];
    case 'review_name':
      return [
        [
          'log',
          () =>
            log.info('Company review-name visibility changed by staff', {
              companyId: change.companyId,
              actorUserId: change.actorUserId,
              hidden: change.hidden,
            }),
        ],
        [
          'analytics',
          () =>
            trackServerAndFlush(ADMIN_COMPANY_SERVER_EVENTS.REVIEW_NAME_TOGGLED, {
              hidden: change.hidden,
              distinct_id: change.actorUserId,
            }),
        ],
        ['revalidate', () => revalidatePath(`/admin/companies/${change.companyId}`)],
      ];
    default:
      return change satisfies never;
  }
}

/**
 * Everything that follows a COMMITTED staff write: business log, analytics, revalidation. Never
 * throws — the write already happened, so a failure here must not be reported back as "nothing
 * was changed".
 */
export function afterCompanyDetailsChange(change: CompanyDetailsChange): void {
  for (const [step, run] of sideEffectSteps(change)) {
    try {
      run();
    } catch (error) {
      log.error('A post-commit step failed after a staff company-details change', {
        kind: change.kind,
        step,
        actorUserId: change.actorUserId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}
