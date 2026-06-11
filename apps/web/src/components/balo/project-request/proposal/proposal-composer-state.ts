/**
 * Pure state module for the expert proposal composer (A6.2 / BAL-288). NO React —
 * the composer holds a single `ProposalDraftState`, and the tabs read/write slices
 * via threaded setters. This module owns the load-bearing, unit-testable logic:
 * the shape, readiness gating (`summaryReadiness`), the derived total / installment
 * sum, and the serialisers that build the autosave + submit payloads.
 *
 * Money is integer minor units everywhere (matches the proposals schema). The
 * client mirrors the server's `validateReadiness` so the disabled-until-ready
 * Submit beat matches what the server would accept — the server re-validates as
 * the source of truth.
 */

import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';
import type { SaveProposalDraftInput } from '@/app/(dashboard)/projects/[requestId]/_actions/save-proposal-draft';
import { plainTextLength } from '@/components/balo/rich-text/plain-text';

export type ProposalPricingMethod = 'fixed' | 'tm';
export type ProposalCadenceValue = 'monthly' | 'fortnightly';

/** One milestone row in composer state. `valueCents` is Fixed-only; kept (not
 *  cleared) across a Fixed→T&M→Fixed switch — the value column is merely hidden. */
export interface ProposalMilestoneDraft {
  /** Stable client-only key for React lists + reorder (NOT persisted). */
  key: string;
  title: string;
  descriptionHtml: string;
  acceptanceCriteria: string;
  valueCents: number | null;
}

/** One installment %-row (Fixed-only). */
export interface ProposalInstallmentDraft {
  key: string;
  label: string;
  pct: number;
}

/** The single composer form-state object. Documents persist immediately via their
 *  own confirm action — they are carried here only for display/removal. */
export interface ProposalDraftState {
  /** Null until the first autosave creates the draft; set thereafter. */
  proposalId: string | null;
  overview: string;
  pricingMethod: ProposalPricingMethod;
  currency: string;
  timeframeWeeks: number | null;
  exclusions: string;
  depositCents: number | null;
  rateCents: number | null;
  cadence: ProposalCadenceValue;
  milestones: ProposalMilestoneDraft[];
  installments: ProposalInstallmentDraft[];
  /** Carried for display/removal; persisted out-of-band by the document actions. */
  documents: ProposalDocumentView[];
}

let keyCounter = 0;

/** Monotonic client-only key for list rows (collision-free within a session). */
export function nextDraftKey(): string {
  keyCounter += 1;
  return `draft-${keyCounter}`;
}

/** The default installment seed for a fresh Fixed draft (design §payment). */
export function seedInstallments(): ProposalInstallmentDraft[] {
  return [
    { key: nextDraftKey(), label: 'Upfront', pct: 30 },
    { key: nextDraftKey(), label: 'On delivery', pct: 70 },
  ];
}

/** A brand-new, empty draft (no proposalId yet). Fixed by default, seeded
 *  installments, one blank milestone so the milestones tab is never empty. */
export function emptyDraftState(): ProposalDraftState {
  return {
    proposalId: null,
    overview: '',
    pricingMethod: 'fixed',
    currency: 'aud',
    timeframeWeeks: null,
    exclusions: '',
    depositCents: null,
    rateCents: null,
    cadence: 'monthly',
    milestones: [
      {
        key: nextDraftKey(),
        title: '',
        descriptionHtml: '',
        acceptanceCriteria: '',
        valueCents: 0,
      },
    ],
    installments: seedInstallments(),
    documents: [],
  };
}

/** Derived total (minor units) for Fixed pricing — sum of milestone values. T&M
 *  has no binding total; the same sum is shown as a non-binding estimate. */
export function computeTotalCents(state: ProposalDraftState): number {
  return state.milestones.reduce((sum, m) => sum + (m.valueCents ?? 0), 0);
}

/** Sum of installment percentages (whole percent, integer — no float rounding). */
export function installmentsSum(state: ProposalDraftState): number {
  return state.installments.reduce((sum, i) => sum + i.pct, 0);
}

export interface ReadinessResult {
  ready: boolean;
  issues: string[];
}

/**
 * Readiness gating (plan §"Readiness checks"). `ready` iff:
 *  - overview non-empty;
 *  - ≥1 milestone, every milestone titled;
 *  - Fixed → installments sum to 100 (≥1) AND every milestone has a value;
 *  - T&M → deposit + rate present (cadence defaulted; installments not required).
 * Each failing check yields a human-readable issue for the amber summary panel.
 */
export function summaryReadiness(state: ProposalDraftState): ReadinessResult {
  const issues: string[] = [];

  if (plainTextLength(state.overview) === 0) {
    issues.push('Add an overview');
  }

  if (state.milestones.length === 0) {
    issues.push('Add at least one milestone');
  } else if (state.milestones.some((m) => m.title.trim().length === 0)) {
    issues.push('A milestone is missing a title');
  }

  if (state.pricingMethod === 'fixed') {
    const sum = installmentsSum(state);
    if (state.installments.length === 0 || sum !== 100) {
      issues.push(`Payment terms ${sum}% — must total 100%`);
    }
    if (state.milestones.some((m) => m.valueCents === null)) {
      issues.push('A milestone is missing a value');
    }
  } else {
    if (state.depositCents === null) {
      issues.push('Add a deposit');
    }
    if (state.rateCents === null) {
      issues.push('Add an hourly rate');
    }
  }

  return { ready: issues.length === 0, issues };
}

/**
 * Serialise composer state → the autosave action payload (replace-all milestone +
 * installment lists every save). T&M-only commercial fields are omitted under
 * Fixed and vice-versa, mirroring the schema's nullable columns; partial-draft
 * tolerant (the autosave action never enforces readiness).
 */
export function toSavePayload(
  state: ProposalDraftState,
  requestId: string,
  relationshipId: string
): SaveProposalDraftInput {
  const isFixed = state.pricingMethod === 'fixed';
  return {
    requestId,
    relationshipId,
    overview: state.overview,
    pricingMethod: state.pricingMethod,
    priceCents: computeTotalCents(state),
    currency: state.currency,
    timeframeWeeks: state.timeframeWeeks ?? undefined,
    exclusions: state.exclusions.trim().length > 0 ? state.exclusions : undefined,
    depositCents: !isFixed && state.depositCents !== null ? state.depositCents : undefined,
    rateCents: !isFixed && state.rateCents !== null ? state.rateCents : undefined,
    cadence: !isFixed ? state.cadence : undefined,
    milestones: state.milestones.map((m) => ({
      title: m.title,
      descriptionHtml: m.descriptionHtml.trim().length > 0 ? m.descriptionHtml : null,
      acceptanceCriteria: m.acceptanceCriteria.trim().length > 0 ? m.acceptanceCriteria : null,
      valueCents: isFixed ? m.valueCents : null,
    })),
    // Installments are Fixed-only; T&M sends an empty set (the server replace-all
    // clears any previously-stored installments after a Fixed→T&M switch).
    installments: isFixed ? state.installments.map((i) => ({ label: i.label, pct: i.pct })) : [],
  };
}
