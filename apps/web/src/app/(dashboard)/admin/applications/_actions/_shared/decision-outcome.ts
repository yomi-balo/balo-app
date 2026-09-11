import 'server-only';
import type { ExpertDeclineReason } from '@balo/shared/experts';
import type { AdminApplicationDecision } from '@/lib/analytics';

/**
 * BAL-549 — copy + result shape shared by both decision actions, so the two cannot drift and
 * jscpd has nothing to flag.
 */
export const APPLICATION_GONE = 'That application no longer exists.'; // pending-MJ
export const APPLICATION_NOT_PENDING = 'That application has already been decided.'; // pending-MJ
export const APPLICATION_GENERIC_FAILURE = 'Could not record the decision. Please try again.'; // pending-MJ

export type DecideApplicationActionResult =
  | {
      success: true;
      analytics: {
        decision: AdminApplicationDecision;
        days_waiting: number;
        reason?: ExpertDeclineReason;
      };
      /** Retrospective attribution for the inline outcome line — the PERSON. */
      decidedByLabel: string;
    }
  | { success: false; error: string; code?: 'not_pending' | 'gone' | 'denied' };
