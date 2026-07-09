/**
 * Serialised, presentation-only view-model for the read-only proposal document
 * (BAL-289 client review). This is the integration contract: later route/server
 * tasks build a {@link ProposalReviewDoc} from the DB and hand it to the
 * presentational components ({@link ../proposal-doc}). No server actions, IDs,
 * or DB types leak through here — every field is a plain serialisable primitive.
 */

/** Expert identity as shown in the proposal header (display strings, not records). */
export interface ProposalExpertIdentity {
  name: string; // full display name, or 'Your expert'
  initials: string; // 1-2 char avatar fallback
  company: string | null;
  headline: string | null; // e.g. 'CPQ Specialist'
  rating: number | null; // 0..5 or null
}

/** One milestone / deliverable row. `valueCents` is only shown for Fixed pricing. */
export interface ProposalReviewMilestone {
  id: string;
  title: string;
  descriptionHtml: string | null;
  acceptanceCriteria: string | null;
  valueCents: number | null;
}

/** A Fixed-pricing payment installment (`pct` is a whole percent, 0..100). */
export interface ProposalReviewInstallment {
  id: string;
  label: string;
  pct: number;
}

/**
 * A proposal-scoped attachment. The single list drives two sections:
 * `kind: 'terms'` folds into the Terms section as a supplement; everything else
 * lists under Attachments.
 */
export interface ProposalReviewAttachment {
  id: string;
  fileName: string;
  sizeBytes: number;
  kind: 'terms' | 'ref';
}

/**
 * Admin-only pricing breakdown (BAL-357). Present ONLY on admin-audience docs.
 * NEVER serialised for expert or client (the audience-boundary invariant — the
 * fee rate and margin must not leak to either party). Carries both sides of every
 * figure: the raw expert quote (100% payout basis) and the `applyBaloFee`'d client
 * price, plus the fee rate and derived margin.
 */
export interface AdminProposalPricing {
  baloFeeBps: number;
  expertPriceCents: number; // raw expert quote (100% payout basis)
  clientPriceCents: number; // applyBaloFee(expertPriceCents, baloFeeBps)
  marginCents: number; // clientPriceCents - expertPriceCents
  expertDepositCents: number | null;
  clientDepositCents: number | null;
  expertRateCents: number | null;
  clientRateCents: number | null;
}

/**
 * The whole serialised proposal document the read view renders.
 *
 * AUDIENCE-RESOLVED MONEY (BAL-357): `priceCents`, `depositCents`, `rateCents`, and
 * each `milestones[].valueCents` are already resolved for the audience this doc was
 * hydrated for — RAW (100% expert quote) for the expert and admin-base lenses,
 * marked up via `applyBaloFee` for the client lens. Installments stay `pct`-only;
 * their amounts derive downstream from the (already audience-correct) `priceCents`.
 * The Balo fee rate is NEVER a field here for expert/client; admins get it inside
 * {@link adminPricing} only.
 */
export interface ProposalReviewDoc {
  id: string;
  relationshipId: string;
  version: number;
  status: 'submitted' | 'changes_requested' | 'resubmitted' | 'accepted' | 'withdrawn' | 'draft';
  pricingMethod: 'fixed' | 'tm';
  overviewHtml: string;
  exclusionsHtml: string | null;
  priceCents: number;
  currency: string;
  timeframeWeeks: number | null;
  depositCents: number | null;
  rateCents: number | null;
  cadence: 'monthly' | 'fortnightly' | null;
  milestones: ProposalReviewMilestone[];
  installments: ProposalReviewInstallment[];
  attachments: ProposalReviewAttachment[];
  expert: ProposalExpertIdentity;
  /**
   * Admin lens only (BAL-357). Structurally UNDEFINED for expert/client docs
   * (asserted absent in `proposal-audience-view.test.ts`) so the fee/margin can
   * never leak to a non-admin surface.
   */
  adminPricing?: AdminProposalPricing;
}
