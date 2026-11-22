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
  /**
   * `/experts/{username}` — the expert's public profile, which the header links the avatar +
   * name to. Non-null ONLY on a client-audience doc whose profile resolves (the shared
   * public-profile rule); `null` for the expert, admin, the composer preview and the public
   * share page.
   */
  profileHref: string | null;
  /**
   * The expert's average rating (BAL-422), 1..5, or `null` for NO REVIEWS.
   *
   * ⚠ `null` IS NOT 0.0 and is NOT "unrated but zero-scored" — the scale starts at 1. Both
   * read components gate the whole rating fragment on `rating !== null`.
   */
  rating: number | null;
  /**
   * ENGAGEMENTS REVIEWED — not review rows (one engagement, one vote). `0` when `rating` is
   * null.
   *
   * ⚠ NON-NULLABLE ON PURPOSE, mirroring `ExpertCardData`. `rating` is the gate; a second
   * nullable field would invite a second, divergent gate. It is rendered WHENEVER `rating`
   * is — an average without its denominator is the thing BAL-422's AC forbids.
   */
  ratingCount: number;
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
 * A proposal-scoped attachment. Every live proposal document lists under Attachments; the
 * terms a proposal commits to are its `additionalTerms` list, not a file.
 */
export interface ProposalReviewAttachment {
  id: string;
  fileName: string;
  sizeBytes: number;
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
  /**
   * BAL-540 — `'declined'` added: the close cascade ends every open proposal on a closed
   * request via this SAME status (D8 — the cause lives on the audit row, never a `proposals`
   * column). Treated exactly like `'withdrawn'` here: neither `isSubmitted` nor `isAccepted`
   * (`review-summary-card.tsx`, `proposal-review.tsx`) matches it, so the decision actions
   * stay hidden and no proposal reads as still-open. A richer "this proposal was declined
   * when the request closed" surface is Phase 6/7 (Builder B), not this widening.
   */
  status:
    | 'submitted'
    | 'changes_requested'
    | 'resubmitted'
    | 'accepted'
    | 'withdrawn'
    | 'draft'
    | 'declined';
  pricingMethod: 'fixed' | 'tm';
  /**
   * The Project T&Cs version recorded when the client accepted, an ISO date. Null before
   * acceptance, and for a proposal accepted before versions were recorded.
   */
  acceptedTermsVersion: string | null;
  overviewHtml: string;
  /**
   * The three clause lists, plain text in the order the expert set them. They carry no money,
   * so they are identical for every audience. Render each body as a React text child, never as
   * HTML.
   */
  assumptions: string[];
  exclusions: string[];
  additionalTerms: string[];
  /**
   * The client company's name, for the copy that names the party ("Northwind pays Balo"). The
   * caller passes `request.company?.name ?? 'the client'`.
   */
  clientCompanyName: string;
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
