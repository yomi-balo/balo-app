/**
 * Pure state module for the expert proposal composer (A6.2 / BAL-288). NO React —
 * the composer holds a single `ProposalDraftState`, and its sections read/write
 * slices via threaded setters. This module owns the load-bearing, unit-testable
 * logic: the shape, readiness (`summaryReadiness`, one `ReadinessIssue` per
 * failing check with a jump target), the derived total / installment sum,
 * installment presets, milestone-allocation maths, and the serialisers that build
 * the autosave + submit payloads.
 *
 * Money is integer minor units everywhere (matches the proposals schema). The
 * client mirrors the server's `validateProposalReadiness` so the checklist matches
 * what the server would accept — the server re-validates as the source of truth.
 */

import { deriveTmTotalCents, sumEstimatedMinutes } from '@balo/shared/pricing';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';
import type { SaveProposalDraftInput } from '@/app/(dashboard)/projects/[requestId]/_actions/save-proposal-draft';
import { plainTextLength } from '@/components/balo/rich-text/plain-text';
import { formatWholeCurrency } from '@/lib/utils/currency';
import type { ProposalDraftPatch } from '@/lib/project-request/proposal/proposal-draft-types';
import { formatProposalAmount } from './proposal-format';

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
  /** Fixed-only deliverable value (integer minor units); null when not set. Only
   *  persisted while `milestonePricingEnabled` is on (see `toSavePayload`). */
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
  /** Fixed-only "Price each milestone" switch. UI-only: derived on hydration
   *  (`hydrateMilestonePricing`) and never persisted — with it off, every milestone
   *  `valueCents` is saved as null. */
  milestonePricingEnabled: boolean;
  /** Carried for display/removal; persisted out-of-band by the document actions. */
  documents: ProposalDocumentView[];
}

let keyCounter = 0;

/** Monotonic client-only key for list rows (collision-free within a session). */
export function nextDraftKey(): string {
  keyCounter += 1;
  return `draft-${keyCounter}`;
}

/** A fresh, untitled milestone row: no amount, and a 0-minute estimate under T&M
 *  (so the hours field starts editable) or none under Fixed. */
export function blankMilestone(method: ProposalPricingMethod): ProposalMilestoneDraft {
  return {
    key: nextDraftKey(),
    title: '',
    descriptionHtml: '',
    acceptanceCriteria: '',
    valueCents: null,
    estimatedMinutes: method === 'tm' ? 0 : null,
  };
}

/** True iff any milestone carries a positive amount — the hydration rule for the
 *  "Price each milestone" switch (legacy 0-seeded drafts hydrate with it off). */
export function hydrateMilestonePricing(
  milestones: readonly Pick<ProposalMilestoneDraft, 'valueCents'>[]
): boolean {
  return milestones.some((m) => (m.valueCents ?? 0) > 0);
}

/** DOM ids shared by the jump targets and the readiness `targetId`s. Never
 *  hand-write one of these strings elsewhere. */
export const COMPOSER_TARGET = {
  overview: 'proposal-overview',
  addMilestone: 'proposal-add-milestone',
  fixedPrice: 'proposal-fixed-price',
  addInstallment: 'proposal-add-installment',
  rate: 'proposal-rate',
  deposit: 'proposal-deposit',
  changeNote: 'proposal-change-note',
} as const;

export function milestoneFieldId(field: 'title' | 'amount' | 'hours', key: string): string {
  return `milestone-${field}-${key}`;
}

export function installmentFieldId(field: 'label' | 'pct', key: string): string {
  return `installment-${field}-${key}`;
}

type InstallmentRow = Pick<ProposalInstallmentDraft, 'label' | 'pct'>;

export type InstallmentPresetKey = 'one' | '30-70' | '50-50' | '30-40-30' | 'per-milestone';

/** Ordered payment-schedule presets. Order is the tie-break for
 *  `matchInstallmentPreset`. */
export const INSTALLMENT_PRESETS: readonly { key: InstallmentPresetKey; label: string }[] = [
  { key: 'one', label: 'One payment' },
  { key: '30-70', label: '30 / 70' },
  { key: '50-50', label: '50 / 50' },
  { key: '30-40-30', label: '30 / 40 / 30' },
  { key: 'per-milestone', label: 'One per milestone' },
];

const FIXED_PRESET_ROWS: Record<
  Exclude<InstallmentPresetKey, 'per-milestone'>,
  InstallmentRow[]
> = {
  one: [{ label: 'On delivery', pct: 100 }],
  '30-70': [
    { label: 'Upfront', pct: 30 },
    { label: 'On delivery', pct: 70 },
  ],
  '50-50': [
    { label: 'Upfront', pct: 50 },
    { label: 'On delivery', pct: 50 },
  ],
  '30-40-30': [
    { label: 'Upfront', pct: 30 },
    { label: 'Midway', pct: 40 },
    { label: 'On delivery', pct: 30 },
  ],
};

type PresetMilestoneState = Pick<ProposalDraftState, 'milestones' | 'milestonePricingEnabled'>;

/**
 * Whole-percent shares of `values` that total exactly 100 (largest-remainder):
 * each row gets its floor, then the leftover points go to the rows with the
 * biggest fractional parts (ties: earlier row). A row left at 0% is lifted to 1%
 * by taking a point from the largest row, so no payment vanishes.
 */
function proportionalPcts(values: readonly number[], total: number): number[] {
  const pcts = values.map((v) => Math.floor((v * 100) / total));
  const byRemainder = values
    .map((v, i) => ({ i, remainder: (v * 100) % total }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  const leftover = 100 - pcts.reduce((sum, p) => sum + p, 0);
  byRemainder.slice(0, leftover).forEach(({ i }) => {
    pcts[i] = (pcts[i] ?? 0) + 1;
  });
  pcts.forEach((pct, i) => {
    if (pct === 0) {
      const donor = pcts.indexOf(Math.max(...pcts));
      pcts[donor] = (pcts[donor] ?? 0) - 1;
      pcts[i] = 1;
    }
  });
  return pcts;
}

function perMilestoneRows(s: PresetMilestoneState): InstallmentRow[] {
  const { milestones } = s;
  if (milestones.length === 0) {
    return FIXED_PRESET_ROWS.one;
  }
  const values = milestones.map((m) => m.valueCents ?? 0);
  const total = values.reduce((sum, v) => sum + v, 0);
  let pcts: number[];
  if (s.milestonePricingEnabled && total > 0 && values.every((v) => v > 0)) {
    pcts = proportionalPcts(values, total);
  } else {
    // Even split: the leftover points go one each to the earliest rows, so the
    // schedule is exactly 100 and no row differs from another by more than 1.
    const even = Math.floor(100 / milestones.length);
    const leftover = 100 - even * milestones.length;
    pcts = milestones.map((_, i) => (i < leftover ? even + 1 : even));
  }
  return milestones.map((m, i) => ({
    label: m.title.trim() || `Milestone ${i + 1}`,
    pct: pcts[i] ?? 0,
  }));
}

function presetRows(key: InstallmentPresetKey, s: PresetMilestoneState): InstallmentRow[] {
  return key === 'per-milestone' ? perMilestoneRows(s) : FIXED_PRESET_ROWS[key];
}

/** Fresh installment rows (new keys) for a preset. */
export function presetInstallments(
  key: InstallmentPresetKey,
  s: PresetMilestoneState
): ProposalInstallmentDraft[] {
  return presetRows(key, s).map((r) => ({ key: nextDraftKey(), label: r.label, pct: r.pct }));
}

/** The default installment seed for a fresh Fixed draft (design §payment): the
 *  `30-70` preset. */
export function seedInstallments(): ProposalInstallmentDraft[] {
  return presetInstallments('30-70', { milestones: [], milestonePricingEnabled: false });
}

/** The first preset (array order) whose label/pct sequence equals the current
 *  installments, or null. Derived, never stored, so it survives hydration. */
export function matchInstallmentPreset(
  s: PresetMilestoneState & Pick<ProposalDraftState, 'installments'>
): InstallmentPresetKey | null {
  const current = s.installments.map((i) => `${i.label.trim()}|${i.pct}`);
  const match = INSTALLMENT_PRESETS.find(({ key }) => {
    const expected = presetRows(key, s).map((r) => `${r.label.trim()}|${r.pct}`);
    return expected.length === current.length && expected.every((e, i) => e === current[i]);
  });
  return match?.key ?? null;
}

/**
 * Carries a milestone-affecting change (`next`, built from `prev`) through to the
 * payment schedule: when `prev`'s installments matched the "One per milestone"
 * preset, they are regenerated from `next`'s milestones (labels and shares), reusing
 * the existing row keys by position. Once the schedule has been edited by hand, or
 * another preset is active, `next` is returned untouched.
 */
export function syncPerMilestoneInstallments(
  prev: ProposalDraftState,
  next: ProposalDraftState
): ProposalDraftState {
  if (matchInstallmentPreset(prev) !== 'per-milestone') return next;
  const installments = presetInstallments('per-milestone', next).map((row, i) => ({
    ...row,
    key: prev.installments[i]?.key ?? row.key,
  }));
  return { ...next, installments };
}

/**
 * Apply an AI-drafted patch (BAL-611): the Overview and one milestone row per drafted
 * milestone, each built from a blank row for the current pricing method. Pricing, installment
 * percentages, timeframe and exclusions are never touched; only a "One per milestone" payment
 * schedule follows the new rows.
 */
export function applyDraftPatch(
  state: ProposalDraftState,
  patch: ProposalDraftPatch
): ProposalDraftState {
  const milestones = patch.milestones.map((drafted) => ({
    ...blankMilestone(state.pricingMethod),
    title: drafted.title,
    descriptionHtml: drafted.descriptionHtml,
    acceptanceCriteria: drafted.acceptanceCriteria,
  }));
  return syncPerMilestoneInstallments(state, {
    ...state,
    overview: patch.overviewHtml,
    milestones,
  });
}

type MilestoneAllocation =
  | { kind: 'no_price'; allocatedCents: number }
  | { kind: 'balanced'; priceCents: number }
  | {
      kind: 'unbalanced';
      priceCents: number;
      allocatedCents: number;
      /** price − Σ milestone amounts (negative when over-allocated). */
      diffCents: number;
      allPriced: boolean;
    };

/** How the Fixed milestone amounts compare with the typed project price. */
export function milestoneAllocation(
  s: Pick<ProposalDraftState, 'milestones' | 'fixedPriceCents'>
): MilestoneAllocation {
  const priceCents = s.fixedPriceCents ?? 0;
  const allocatedCents = s.milestones.reduce((sum, m) => sum + (m.valueCents ?? 0), 0);
  if (priceCents <= 0) {
    return { kind: 'no_price', allocatedCents };
  }
  const allPriced = s.milestones.every((m) => (m.valueCents ?? 0) > 0);
  if (allPriced && allocatedCents === priceCents) {
    return { kind: 'balanced', priceCents };
  }
  return {
    kind: 'unbalanced',
    priceCents,
    allocatedCents,
    diffCents: priceCents - allocatedCents,
    allPriced,
  };
}

/** A brand-new, empty draft (no proposalId yet). Fixed by default, seeded
 *  installments, one blank milestone so the milestones section is never empty. */
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
    milestones: [blankMilestone('fixed')],
    installments: seedInstallments(),
    milestonePricingEnabled: false,
    documents: [],
  };
}

/**
 * The SINGLE write path for `price_cents` (BAL-294) — ASYMMETRIC by method:
 *  - T&M  → server-derived `round(sum(estimatedMinutes)/60 × rateCents)`. The
 *           expert never types it; it falls out of effort × rate. Uses the SOLE
 *           formula site `deriveTmTotalCents` from `@balo/shared/pricing` (shared with the
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

export type ReadinessIssueId =
  | 'overview'
  | 'milestones_none'
  | 'milestone_title'
  | 'price'
  | 'milestone_amounts'
  | 'milestone_allocation'
  | 'installments_none'
  | 'installments_sum'
  | 'rate'
  | 'deposit'
  | 'milestone_hours'
  | 'change_request';

/** One failing readiness check. React key = `${id}:${targetId}` (`milestone_title`
 *  repeats per row). `targetId` is the DOM id the checklist jumps to. */
export interface ReadinessIssue {
  id: ReadinessIssueId;
  label: string;
  targetId: string;
}

export interface ReadinessResult {
  ready: boolean;
  issues: ReadinessIssue[];
}

/** "…milestone {n}" for a single offender, else the plural copy. `missing` holds
 *  0-based row indexes. */
function missingMilestoneLabel(
  singular: string,
  plural: (count: number) => string,
  missing: readonly number[]
): string {
  const [only] = missing;
  return missing.length === 1 && only !== undefined
    ? `${singular} ${only + 1}`
    : plural(missing.length);
}

function sharedIssues(state: ProposalDraftState): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  if (plainTextLength(state.overview) === 0) {
    issues.push({ id: 'overview', label: 'Add an overview', targetId: COMPOSER_TARGET.overview });
  }
  if (state.milestones.length === 0) {
    issues.push({
      id: 'milestones_none',
      label: 'Add at least one milestone',
      targetId: COMPOSER_TARGET.addMilestone,
    });
  }
  state.milestones.forEach((m, i) => {
    if (m.title.trim().length === 0) {
      issues.push({
        id: 'milestone_title',
        label: `Milestone ${i + 1} needs a title`,
        targetId: milestoneFieldId('title', m.key),
      });
    }
  });
  return issues;
}

function fixedIssues(state: ProposalDraftState): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  if ((state.fixedPriceCents ?? 0) <= 0) {
    issues.push({
      id: 'price',
      label: 'Set your project price',
      targetId: COMPOSER_TARGET.fixedPrice,
    });
  }
  if (state.milestonePricingEnabled) {
    issues.push(...milestoneAmountIssues(state));
  }
  if (state.installments.length === 0) {
    issues.push({
      id: 'installments_none',
      label: 'Add a payment to the schedule',
      targetId: COMPOSER_TARGET.addInstallment,
    });
  } else {
    const sum = installmentsSum(state);
    const [firstInstallment] = state.installments;
    if (sum !== 100 && firstInstallment !== undefined) {
      issues.push({
        id: 'installments_sum',
        label: `Payments add up to ${sum}%, not 100%`,
        targetId: installmentFieldId('pct', firstInstallment.key),
      });
    }
  }
  return issues;
}

function milestoneAmountIssues(state: ProposalDraftState): ReadinessIssue[] {
  const missing = state.milestones.flatMap((m, i) => ((m.valueCents ?? 0) <= 0 ? [i] : []));
  const [firstMissing] = missing;
  const missingMilestone = firstMissing === undefined ? undefined : state.milestones[firstMissing];
  if (missingMilestone !== undefined) {
    return [
      {
        id: 'milestone_amounts',
        label: missingMilestoneLabel(
          'Set an amount for milestone',
          (k) => `Set amounts for ${k} milestones`,
          missing
        ),
        targetId: milestoneFieldId('amount', missingMilestone.key),
      },
    ];
  }
  const allocation = milestoneAllocation(state);
  const [firstMilestone] = state.milestones;
  if (allocation.kind === 'unbalanced' && allocation.allPriced && firstMilestone !== undefined) {
    return [
      {
        id: 'milestone_allocation',
        label: `Milestones add up to ${formatProposalAmount(allocation.allocatedCents, state.currency)}, not ${formatProposalAmount(allocation.priceCents, state.currency)}`,
        targetId: milestoneFieldId('amount', firstMilestone.key),
      },
    ];
  }
  return [];
}

function tmIssues(state: ProposalDraftState): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  if (state.rateCents === null) {
    issues.push({
      id: 'rate',
      label: 'Set your hourly rate',
      targetId: COMPOSER_TARGET.rate,
    });
  }
  if (state.depositCents === null) {
    issues.push({
      id: 'deposit',
      label: `Set a deposit (it can be ${formatWholeCurrency(0, state.currency)})`,
      targetId: COMPOSER_TARGET.deposit,
    });
  }
  const missing = state.milestones.flatMap((m, i) => (m.estimatedMinutes === null ? [i] : []));
  const [firstMissing] = missing;
  const missingMilestone = firstMissing === undefined ? undefined : state.milestones[firstMissing];
  if (missingMilestone !== undefined) {
    issues.push({
      id: 'milestone_hours',
      label: missingMilestoneLabel(
        'Add an hour estimate for milestone',
        (k) => `Add hour estimates for ${k} milestones`,
        missing
      ),
      targetId: milestoneFieldId('hours', missingMilestone.key),
    });
  }
  return issues;
}

/**
 * Readiness (plan §"Readiness checks"), in checklist order. `ready` iff no issue:
 *  - overview non-empty;
 *  - ≥1 milestone, every milestone titled;
 *  - Fixed → project price > 0; with "Price each milestone" on, every milestone
 *    has an amount and the amounts add up to the price; ≥1 installment summing
 *    to 100;
 *  - T&M → rate + deposit present and every milestone has an hour estimate
 *    (mirrors the `tm_missing_effort` server guard); installments not required.
 * Each failing check is one `ReadinessIssue` carrying the DOM id to jump to. The
 * soft `change_request` issue is added by the composer, not here.
 */
export function summaryReadiness(state: ProposalDraftState): ReadinessResult {
  const issues = [
    ...sharedIssues(state),
    ...(state.pricingMethod === 'fixed' ? fixedIssues(state) : tmIssues(state)),
  ];
  return { ready: issues.length === 0, issues };
}

/**
 * Serialise composer state → the autosave action payload (replace-all milestone +
 * installment lists every save). A cleared optional header field is sent as `null`
 * — never omitted — so the save clears the stored column: an empty timeframe or
 * exclusions, and the T&M-only deposit/rate/cadence under Fixed. Partial-draft
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
    timeframeWeeks: state.timeframeWeeks,
    exclusions: state.exclusions.trim().length > 0 ? state.exclusions : null,
    depositCents: isFixed ? null : state.depositCents,
    rateCents: isFixed ? null : state.rateCents,
    cadence: isFixed ? null : state.cadence,
    milestones: state.milestones.map((m) => ({
      title: m.title,
      descriptionHtml: m.descriptionHtml.trim().length > 0 ? m.descriptionHtml : null,
      acceptanceCriteria: m.acceptanceCriteria.trim().length > 0 ? m.acceptanceCriteria : null,
      // The two pricing columns are mutually exclusive by method: Fixed persists
      // `valueCents` (only while "Price each milestone" is on) and force-nulls
      // effort; T&M persists `estimatedMinutes` and force-nulls `valueCents`
      // (mirrors the schema's nullable columns + the coherence guard).
      valueCents: isFixed && state.milestonePricingEnabled ? m.valueCents : null,
      estimatedMinutes: isFixed ? null : (m.estimatedMinutes ?? null),
    })),
    // Installments are Fixed-only; T&M sends an empty set (the server replace-all
    // clears any previously-stored installments after a Fixed→T&M switch).
    installments: isFixed ? state.installments.map((i) => ({ label: i.label, pct: i.pct })) : [],
  };
}
