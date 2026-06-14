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

import { deriveTmTotalCents, sumEstimatedMinutes } from '@balo/db';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';
import type { SaveProposalDraftInput } from '@/app/(dashboard)/projects/[requestId]/_actions/save-proposal-draft';
import { plainTextLength } from '@/components/balo/rich-text/plain-text';

export type ProposalPricingMethod = 'fixed' | 'tm';
export type ProposalCadenceValue = 'monthly' | 'fortnightly';

/** One milestone row in composer state. `valueCents` is Fixed-only and
 *  `estimatedMinutes` is T&M-only; each is kept (not cleared) across a method
 *  switch — the off-method column is merely hidden, then reappears on switch back
 *  (mirrors the "keep, just hide" convention). They are mutually exclusive at
 *  persistence (BAL-294): `toSavePayload` force-nulls the off-method field. */
export interface ProposalMilestoneDraft {
  /** Stable client-only key for React lists + reorder (NOT persisted). */
  key: string;
  title: string;
  descriptionHtml: string;
  acceptanceCriteria: string;
  /** Fixed-only deliverable value (integer minor units); null when not set. */
  valueCents: number | null;
  /** T&M-only estimated effort in MINUTES (integer); null when not estimated. The
   *  milestones tab edits this in hours (0.25 step) and stores minutes. */
  estimatedMinutes: number | null;
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
  /** Fixed-only EXPERT-TYPED total (integer minor units). Null until typed. Fully
   *  decoupled from milestone `valueCents` / hours: under Fixed it IS the proposal
   *  total. Ignored under T&M (the total derives from effort × rate instead) but
   *  retained in state so a Fixed→T&M→Fixed round-trip restores the typed price. */
  fixedPriceCents: number | null;
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
    fixedPriceCents: null,
    cadence: 'monthly',
    milestones: [
      {
        key: nextDraftKey(),
        title: '',
        descriptionHtml: '',
        acceptanceCriteria: '',
        valueCents: 0,
        estimatedMinutes: null,
      },
    ],
    installments: seedInstallments(),
    documents: [],
  };
}

/**
 * The SINGLE write path for `price_cents` (BAL-294) — ASYMMETRIC by method:
 *  - T&M  → server-derived `round(sum(estimatedMinutes)/60 × rateCents)`. The
 *           expert never types it; it falls out of effort × rate. Uses the SOLE
 *           formula site `deriveTmTotalCents` from `@balo/db` (shared with the
 *           coherence guard so the displayed total and the validated total never
 *           drift). Null rate → 0.
 *  - Fixed → the expert-TYPED `fixedPriceCents` (NOT the milestone `valueCents`
 *           sum). Per-milestone `valueCents` remain a breakdown the
 *           `fixed_milestone_values_exceed_price` guard caps against this total.
 *
 * Both the summary card and `toSavePayload` call this; no other site recomputes
 * the total. Memoised in the composer via `useMemo([state])`.
 */
export function computeTotalCents(state: ProposalDraftState): number {
  if (state.pricingMethod === 'tm') {
    return deriveTmTotalCents(sumEstimatedMinutes(state.milestones), state.rateCents ?? 0);
  }
  return state.fixedPriceCents ?? 0;
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
 *  - T&M → deposit + rate present, AND every milestone has an effort estimate
 *    (mirrors the `tm_missing_effort` server guard); cadence defaulted;
 *    installments not required.
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
    if (state.milestones.some((m) => m.estimatedMinutes === null)) {
      issues.push('A milestone is missing an effort estimate');
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
    cadence: isFixed ? undefined : state.cadence,
    milestones: state.milestones.map((m) => ({
      title: m.title,
      descriptionHtml: m.descriptionHtml.trim().length > 0 ? m.descriptionHtml : null,
      acceptanceCriteria: m.acceptanceCriteria.trim().length > 0 ? m.acceptanceCriteria : null,
      // The two pricing columns are mutually exclusive by method: Fixed persists
      // `valueCents` and force-nulls effort; T&M persists `estimatedMinutes` and
      // force-nulls `valueCents` (mirrors the schema's nullable columns + the
      // coherence guard).
      valueCents: isFixed ? m.valueCents : null,
      estimatedMinutes: isFixed ? null : (m.estimatedMinutes ?? null),
    })),
    // Installments are Fixed-only; T&M sends an empty set (the server replace-all
    // clears any previously-stored installments after a Fixed→T&M switch).
    installments: isFixed ? state.installments.map((i) => ({ label: i.label, pct: i.pct })) : [],
  };
}
