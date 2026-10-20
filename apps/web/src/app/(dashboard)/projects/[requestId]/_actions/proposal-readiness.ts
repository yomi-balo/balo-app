import 'server-only';

import { installmentsSumTo100 } from '@balo/db';
import { plainTextLength } from '@/components/balo/rich-text/plain-text';

/**
 * Shared server-side proposal readiness re-validation (A6.2 submit + A6.4 resubmit).
 * Extracted from `submit-proposal.ts` so the resubmit action re-uses the EXACT same
 * gating (never trust the client; both surfaces re-validate as the source of truth)
 * instead of copy-pasting it (keeps SonarCloud duplication < 3%).
 *
 * Mirrors the composer's `summaryReadiness`:
 *  - overview non-empty (post-sanitise);
 *  - ≥1 milestone, every milestone titled;
 *  - Fixed → price > 0, installments sum to 100 (≥1), AND milestone amounts are
 *    all-or-none: either every milestone is unvalued, or every milestone has a
 *    positive value and the values add up to the price;
 *  - T&M → deposit + rate present AND every milestone has an effort estimate
 *    (mirrors the `tm_missing_effort` server guard; installments not required).
 *
 * Inputs are structural minimal shapes so both the DB-row (`ProposalMilestone`) and
 * the composer-payload milestone/installment shapes satisfy them without coupling.
 */

export type ReadinessResult = { ready: true } | { ready: false; error: string };

/** Minimal milestone shape the readiness gate needs. */
export interface ReadinessMilestone {
  title: string;
  valueCents: number | null;
  /** T&M-only estimated effort in minutes (BAL-294); null when not estimated. */
  estimatedMinutes: number | null;
}

/** Minimal installment shape the readiness gate needs. */
export interface ReadinessInstallment {
  pct: number;
}

/** Amounts are optional on a Fixed proposal, but all-or-none and summing to the price. */
function milestoneAmountsAddUp(milestones: ReadinessMilestone[], priceCents: number): boolean {
  const valued = milestones.flatMap((m) => (m.valueCents === null ? [] : [m.valueCents]));
  if (valued.length === 0) {
    return true;
  }
  if (valued.length !== milestones.length || valued.some((v) => v <= 0)) {
    return false;
  }
  return valued.reduce((sum, v) => sum + v, 0) === priceCents;
}

export function validateProposalReadiness(input: {
  overview: string;
  pricingMethod: 'fixed' | 'tm';
  milestones: ReadinessMilestone[];
  installments: ReadinessInstallment[];
  depositCents: number | null;
  rateCents: number | null;
  priceCents: number;
}): ReadinessResult {
  if (plainTextLength(input.overview) === 0) {
    return { ready: false, error: 'Add an overview before submitting.' };
  }
  if (input.milestones.length === 0) {
    return { ready: false, error: 'Add at least one milestone before submitting.' };
  }
  if (input.milestones.some((m) => m.title.trim().length === 0)) {
    return { ready: false, error: 'Every milestone needs a title.' };
  }

  if (input.pricingMethod === 'fixed') {
    if (input.priceCents <= 0) {
      return { ready: false, error: 'Set your project price before submitting.' };
    }
    if (input.installments.length === 0 || !installmentsSumTo100(input.installments)) {
      return { ready: false, error: 'Payment installments must total 100%.' };
    }
    if (!milestoneAmountsAddUp(input.milestones, input.priceCents)) {
      return { ready: false, error: 'Milestone amounts must add up to your project price.' };
    }
    return { ready: true };
  }

  // T&M
  if (input.depositCents === null || input.rateCents === null) {
    return { ready: false, error: 'Add a deposit and an hourly rate before submitting.' };
  }
  if (input.milestones.some((m) => m.estimatedMinutes === null)) {
    return { ready: false, error: 'Every milestone needs an effort estimate.' };
  }
  return { ready: true };
}
