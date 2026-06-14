/**
 * Proposal / engagement commercial-coherence guard (BAL-293).
 *
 * A PURE, transport-agnostic validator — NO `db` import, NO I/O, NO analytics.
 * Same "tiny standalone module" spirit as `proposal-types.ts`. Its only dependency
 * is the equally-pure `proposal-pricing.ts` (the single source of truth for the
 * T&M total formula, shared with the web composer — BAL-294). It is the
 * application-level transition invariant that sits ABOVE the DB CHECK constraints
 * (`proposal_price_cents_nonneg`, `proposal_installment_pct_range`, …) and BELOW
 * the web inline `validateProposalReadiness` UX layer — defence-in-depth.
 *
 * The repository wires `assertProposalCoherent` into every COMMITTING proposal
 * path (`submit`, `promoteToSubmit`, `accept`, `resubmit`) and
 * `assertEngagementTermsCoherent` into the engagement seam (`create`,
 * `materializeFromKickoff`). Drafts (`createDraft`/`updateDraft`) stay UNVALIDATED
 * — they are deliberately allowed to be saved incomplete.
 *
 * The named-domain-error pattern mirrors `InvalidProposalTransitionError` /
 * `ProposalNotDraftError` (proposals.ts) / `KickoffGatesIncompleteError`
 * (engagements.ts): a typed `Error` subclass carrying a structured discriminant
 * (`rule`) plus a human-readable message, `instanceof`-checked at each entry point
 * and re-exported from `repositories/index.ts`.
 */

import { deriveTmTotalCents, sumEstimatedMinutes } from './proposal-pricing';

/**
 * The `rule` discriminant for a failed proposal-coherence clause. The string union
 * is the analytics/error contract — web/analytics consumers `instanceof`-check
 * `ProposalCoherenceError` and read `.rule`.
 */
export type ProposalCoherenceRule =
  | 'price_negative' // priceCents must be >= 0
  | 'deposit_negative' // depositCents, if present, must be >= 0
  | 'tm_missing_rate' // tm ⇒ rateCents present & >= 0 AND cadence present
  | 'fixed_requires_installments' // fixed ⇒ >= 1 installment row
  | 'installments_not_100' // fixed ⇒ live installments' pct sum EXACTLY 100 (integer)
  | 'tm_has_installments' // tm ⇒ NO installment rows (reject, don't silently drop)
  | 'fixed_milestone_values_exceed_price' // fixed ⇒ sum(present milestone valueCents) <= priceCents
  | 'tm_missing_effort' // tm ⇒ every live milestone has estimatedMinutes present & >= 0
  | 'tm_total_mismatch'; // tm ⇒ priceCents == round(sum(estimatedMinutes)/60 × rateCents) ± N

/**
 * The header-only subset for the engagement seam. These three are exactly the
 * shared `checkHeaderTerms` clauses, so the mapping from a header-check result to
 * either error class is 1:1 and type-safe.
 */
export type EngagementTermsCoherenceRule =
  | 'price_negative'
  | 'deposit_negative'
  | 'tm_missing_rate';

/**
 * The assembled coherence snapshot — a minimal STRUCTURAL shape both the DB-row
 * header (`Proposal`) and caller-input headers satisfy. Differs from the
 * caller-input types AND the DB-row types on purpose (mirrors the minimal-interface
 * style of `proposal-readiness.ts` `ReadinessMilestone`/`ReadinessInstallment`).
 * Money is integer minor units. Uses literal unions (not the `PricingMethod` /
 * `ProposalCadence` aliases) so the module stays decoupled.
 */
export interface ProposalCoherenceSnapshot {
  pricingMethod: 'fixed' | 'tm';
  priceCents: number;
  /** Present for completeness; v1 has NO currency clause. */
  currency: string;
  depositCents: number | null;
  rateCents: number | null;
  cadence: 'monthly' | 'fortnightly' | null;
  /** Live milestones (soft-deleted rows must never be included). `valueCents` is
   *  Fixed-only; `estimatedMinutes` is T&M-only — mutually exclusive by method. */
  milestones: { valueCents: number | null; estimatedMinutes: number | null }[];
  installments: { pct: number }[];
}

/** Header-only commercial terms for the engagement seam (no milestones/installments). */
export interface EngagementTermsSnapshot {
  pricingMethod: 'fixed' | 'tm';
  priceCents: number;
  depositCents: number | null;
  rateCents: number | null;
  cadence: 'monthly' | 'fortnightly' | null;
}

/**
 * Thrown by `assertProposalCoherent` when a committing proposal would be
 * incoherent. Carries the structured `rule` discriminant + a human-readable
 * message. Modelled on `InvalidProposalTransitionError`.
 */
export class ProposalCoherenceError extends Error {
  constructor(
    public readonly rule: ProposalCoherenceRule,
    message: string
  ) {
    super(message);
    this.name = 'ProposalCoherenceError';
  }
}

/**
 * Thrown by `assertEngagementTermsCoherent` when an engagement's snapshotted
 * commercial terms are incoherent (header-only). Same shape as
 * `ProposalCoherenceError` but a distinct class + a narrower `rule` union.
 */
export class EngagementTermsCoherenceError extends Error {
  constructor(
    public readonly rule: EngagementTermsCoherenceRule,
    message: string
  ) {
    super(message);
    this.name = 'EngagementTermsCoherenceError';
  }
}

/**
 * The header-level commercial terms shared by BOTH the proposal snapshot and the
 * engagement-terms snapshot. The two shared shapes structurally satisfy this.
 */
interface HeaderTerms {
  pricingMethod: 'fixed' | 'tm';
  priceCents: number;
  depositCents: number | null;
  rateCents: number | null;
  cadence: 'monthly' | 'fortnightly' | null;
}

/**
 * Human-readable message for each rule. Centralised so the proposal + engagement
 * asserts emit identical copy for the shared header clauses.
 */
const RULE_MESSAGES: Record<ProposalCoherenceRule, string> = {
  price_negative: 'Price must not be negative.',
  deposit_negative: 'Deposit must not be negative.',
  tm_missing_rate: 'Time & materials pricing requires a non-negative rate and a billing cadence.',
  fixed_requires_installments: 'Fixed-price proposals require at least one payment installment.',
  installments_not_100: 'Payment installments must total exactly 100%.',
  tm_has_installments: 'Time & materials proposals must not carry payment installments.',
  fixed_milestone_values_exceed_price:
    'The sum of milestone values must not exceed the proposal price.',
  tm_missing_effort: 'Time & materials proposals require an estimated effort on every milestone.',
  tm_total_mismatch: 'The total must equal the estimated effort multiplied by the hourly rate.',
};

/**
 * The three shared header-level clauses, evaluated in deterministic
 * first-failure-wins order: `price_negative` → `deposit_negative` →
 * `tm_missing_rate`. Returns the first failing rule, or `null` if the header is
 * coherent. Consumed by BOTH public asserts; each wraps the returned rule in its
 * OWN error class (the three rules are members of both unions).
 */
function checkHeaderTerms(t: HeaderTerms): EngagementTermsCoherenceRule | null {
  if (t.priceCents < 0) {
    return 'price_negative';
  }
  if (t.depositCents !== null && t.depositCents < 0) {
    return 'deposit_negative';
  }
  if (t.pricingMethod === 'tm') {
    if (t.rateCents === null || t.rateCents < 0 || t.cadence === null) {
      return 'tm_missing_rate';
    }
  }
  return null;
}

/**
 * Assert a committing proposal's commercial terms are coherent. Throws
 * `ProposalCoherenceError` on the FIRST failing clause, returns `void` on success.
 *
 * Clause evaluation order (deterministic, first-failure-wins):
 *   1. header: `price_negative` → `deposit_negative` → `tm_missing_rate`
 *   2. fixed-only: `fixed_requires_installments` → `installments_not_100`
 *      → `fixed_milestone_values_exceed_price`
 *   3. tm-only: `tm_has_installments` → `tm_missing_effort` → `tm_total_mismatch`
 *
 * NOTE (v1 scope): a `fixed` proposal whose milestones all have `null` valueCents
 * is COHERENT here (present-value sum 0 <= price). The "every fixed milestone needs
 * a value" rule lives ONLY in the web `validateProposalReadiness`, not in this
 * integrity guard. Likewise zero milestones is allowed by this guard (≥1 milestone
 * is a UX-layer rule): a `tm` proposal with NO milestones is vacuously coherent iff
 * `priceCents === 0` — the legacy header-only `submit()` path (empty milestones,
 * `priceCents` 0) MUST pass. The guard enforces exactly the nine listed clauses.
 */
export function assertProposalCoherent(snapshot: ProposalCoherenceSnapshot): void {
  // 1. Shared header clauses.
  const headerRule = checkHeaderTerms(snapshot);
  if (headerRule !== null) {
    throw new ProposalCoherenceError(headerRule, RULE_MESSAGES[headerRule]);
  }

  if (snapshot.pricingMethod === 'fixed') {
    // 2. fixed-only clauses.
    if (snapshot.installments.length === 0) {
      throw new ProposalCoherenceError(
        'fixed_requires_installments',
        RULE_MESSAGES.fixed_requires_installments
      );
    }
    // Integer sum — inlined (do NOT import `installmentsSumTo100`; keep this module
    // dependency-free).
    const pctTotal = snapshot.installments.reduce((sum, i) => sum + i.pct, 0);
    if (pctTotal !== 100) {
      throw new ProposalCoherenceError('installments_not_100', RULE_MESSAGES.installments_not_100);
    }
    // Only present (non-null) milestone values count toward the sum.
    const milestoneValueTotal = snapshot.milestones.reduce(
      (sum, m) => sum + (m.valueCents ?? 0),
      0
    );
    if (milestoneValueTotal > snapshot.priceCents) {
      throw new ProposalCoherenceError(
        'fixed_milestone_values_exceed_price',
        RULE_MESSAGES.fixed_milestone_values_exceed_price
      );
    }
    return;
  }

  // 3. tm-only clauses.
  if (snapshot.installments.length > 0) {
    throw new ProposalCoherenceError('tm_has_installments', RULE_MESSAGES.tm_has_installments);
  }

  // 4. tm-only effort + derived-total clauses (BAL-294). `rateCents` is provably
  //    non-null/non-negative here (`tm_missing_rate` ran first in checkHeaderTerms);
  //    narrow it defensively anyway so the formula inputs are statically `number`.
  if (snapshot.rateCents === null || snapshot.rateCents < 0) {
    throw new ProposalCoherenceError('tm_missing_rate', RULE_MESSAGES.tm_missing_rate);
  }
  // Every LIVE milestone must carry a present, non-negative effort. Zero milestones
  // ⇒ `[].some(...)` is false ⇒ vacuously passes (legacy empty-milestone tm path).
  if (snapshot.milestones.some((m) => m.estimatedMinutes === null || m.estimatedMinutes < 0)) {
    throw new ProposalCoherenceError('tm_missing_effort', RULE_MESSAGES.tm_missing_effort);
  }
  // priceCents must equal the derived total within ±N, N = milestone count (1 cent
  // per milestone — belt-and-braces against per-milestone rounding; the UI sums
  // minutes then derives ONCE, which is exact). Zero milestones ⇒ derived 0,
  // tolerance 0 ⇒ passes iff priceCents === 0.
  const totalMinutes = sumEstimatedMinutes(snapshot.milestones);
  const derived = deriveTmTotalCents(totalMinutes, snapshot.rateCents);
  const tolerance = snapshot.milestones.length;
  if (Math.abs(snapshot.priceCents - derived) > tolerance) {
    throw new ProposalCoherenceError('tm_total_mismatch', RULE_MESSAGES.tm_total_mismatch);
  }
}

/**
 * Assert an engagement's snapshotted commercial terms are coherent — header-only
 * (no milestones/installments). Applies exactly the three shared clauses
 * (`price_negative`, `deposit_negative`, `tm_missing_rate`). Throws
 * `EngagementTermsCoherenceError` on the first failing clause, returns `void` on
 * success. A coherent accepted proposal's snapshotted terms always pass.
 */
export function assertEngagementTermsCoherent(terms: EngagementTermsSnapshot): void {
  const rule = checkHeaderTerms(terms);
  if (rule !== null) {
    throw new EngagementTermsCoherenceError(rule, RULE_MESSAGES[rule]);
  }
}
