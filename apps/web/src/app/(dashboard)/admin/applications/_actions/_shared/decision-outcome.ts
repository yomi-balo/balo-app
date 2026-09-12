import 'server-only';
import type { ExpertDeclineReason } from '@balo/shared/experts';
import type { AdminApplicationDecision } from '@/lib/analytics';
import type { DecisionFailureCode } from '../../_lib/decision-staleness';

/**
 * BAL-549 — copy + result shape shared by both decision actions, so the two cannot drift and
 * jscpd has nothing to flag.
 *
 * ⚠ THE `code` UNION IS DEFINED IN `_lib/decision-staleness.ts`, NOT HERE (web-review fix round,
 * W3). This module is `server-only`, so the two `'use client'` callers that must ACT on a code
 * cannot import a value from it; the union and the "is this stale?" predicate therefore live in
 * the client-safe `_lib`, and this module imports the type back. One definition either way.
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
  | { success: false; error: string; code?: DecisionFailureCode };
