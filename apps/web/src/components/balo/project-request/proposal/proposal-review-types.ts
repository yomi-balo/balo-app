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

/** The whole serialised proposal document the read view renders. */
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
}
