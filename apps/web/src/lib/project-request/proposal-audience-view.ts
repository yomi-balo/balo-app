/**
 * Audience-keyed proposal serialiser (BAL-357). Extracted from the proposal RSC
 * page so it is importable and unit-testable without the route. Maps a persisted
 * proposal (+ its children) into the presentation-only {@link ProposalReviewDoc},
 * applying the Balo fee at the serializer boundary keyed by audience:
 *
 *  - `expert` → identity: every money figure is the raw 100%-payout quote.
 *  - `client` → `applyBaloFee` grosses up `priceCents`, `depositCents`, `rateCents`,
 *               and each milestone `valueCents` (null-safe). The fee rate is NEVER
 *               copied into the doc.
 *  - `admin`  → identity base numbers (the admin reads the expert quote in the body)
 *               PLUS an {@link AdminProposalPricing} breakdown carrying both sides,
 *               the fee rate, and the derived margin.
 *
 * The fee rate (`proposal.baloFeeBps`) is structurally absent from expert/client
 * docs — only `admin` docs carry it, inside `adminPricing`. Installments keep `pct`
 * only; their amounts derive downstream from the (already audience-correct)
 * `priceCents`, so the existing `round(total × pct / 100)` sites need no change.
 *
 * Money stays in integer cents; no dates cross the boundary (the review shows none).
 */

import type {
  Proposal,
  ProposalMilestone,
  ProposalPaymentInstallment,
  ProposalDocument,
  ProjectRequestWithRelations,
} from '@balo/db';
import { applyBaloFee } from '@balo/shared/pricing';
import type {
  ProposalReviewDoc,
  AdminProposalPricing,
} from '@/components/balo/project-request/proposal/proposal-review-types';

/** Which viewer a proposal doc is serialised for. Drives the fee-application rule. */
export type ProposalAudience = 'expert' | 'client' | 'admin';

type Relationship = ProjectRequestWithRelations['relationships'][number];

/** Full display name from first/last, or the given fallback when both are blank. */
function fullNameOf(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  fallback: string
): string {
  const full = [firstName, lastName]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' ');
  return full.length > 0 ? full : fallback;
}

/** 1-2 char avatar fallback from first/last initials, or 'EX' when both blank. */
function initialsOf(
  firstName: string | null | undefined,
  lastName: string | null | undefined
): string {
  const initials = [firstName, lastName]
    .map((part) => (part ?? '').trim().charAt(0).toUpperCase())
    .filter((char) => char.length > 0)
    .join('');
  return initials.length > 0 ? initials : 'EX';
}

/**
 * Build the admin-only pricing breakdown from the raw proposal. Both sides of every
 * figure: the raw expert quote (payout basis) and the `applyBaloFee`'d client price,
 * plus the fee rate and the derived margin. Admin-only — never attached to
 * expert/client docs.
 */
function buildAdminPricing(proposal: Proposal): AdminProposalPricing {
  const feeBps = proposal.baloFeeBps;
  const expertPriceCents = proposal.priceCents;
  const clientPriceCents = applyBaloFee(expertPriceCents, feeBps);
  return {
    baloFeeBps: feeBps,
    expertPriceCents,
    clientPriceCents,
    marginCents: clientPriceCents - expertPriceCents,
    expertDepositCents: proposal.depositCents,
    clientDepositCents:
      proposal.depositCents === null ? null : applyBaloFee(proposal.depositCents, feeBps),
    expertRateCents: proposal.rateCents,
    clientRateCents: proposal.rateCents === null ? null : applyBaloFee(proposal.rateCents, feeBps),
  };
}

/**
 * Map a persisted proposal (+ its children) into the serialisable, presentation-
 * only {@link ProposalReviewDoc} the read/submitted views render, resolving money
 * for `audience` (see the module doc). Expert identity is derived from the only
 * fields `findByIdWithRelations` hydrates on each relationship:
 * `expertProfile.user.{firstName,lastName}`. `company`, `headline`, and `rating`
 * are NOT on that graph, so they degrade to `null` — the read components hide those
 * rows when null (no invented fields).
 */
export function hydrateReviewDoc(
  proposal: Proposal,
  milestones: ProposalMilestone[],
  installments: ProposalPaymentInstallment[],
  documents: ProposalDocument[],
  relationship: Relationship,
  audience: ProposalAudience
): ProposalReviewDoc {
  const expertUser = relationship.expertProfile.user;
  // Client sees the grossed-up figure; expert + admin-base stay at the raw quote.
  const priceFn =
    audience === 'client'
      ? (cents: number): number => applyBaloFee(cents, proposal.baloFeeBps)
      : (cents: number): number => cents;
  const priceFnNullable = (cents: number | null): number | null =>
    cents === null ? null : priceFn(cents);

  const doc: ProposalReviewDoc = {
    id: proposal.id,
    relationshipId: proposal.relationshipId,
    version: proposal.version,
    status: proposal.status,
    pricingMethod: proposal.pricingMethod,
    overviewHtml: proposal.overview,
    exclusionsHtml: proposal.exclusions,
    priceCents: priceFn(proposal.priceCents),
    currency: proposal.currency,
    timeframeWeeks: proposal.timeframeWeeks,
    depositCents: priceFnNullable(proposal.depositCents),
    rateCents: priceFnNullable(proposal.rateCents),
    cadence: proposal.cadence,
    milestones: milestones.map((m) => ({
      id: m.id,
      title: m.title,
      descriptionHtml: m.descriptionHtml,
      acceptanceCriteria: m.acceptanceCriteria,
      valueCents: priceFnNullable(m.valueCents),
    })),
    installments: installments.map((i) => ({ id: i.id, label: i.label, pct: i.pct })),
    attachments: documents.map((d) => ({
      id: d.id,
      fileName: d.fileName,
      sizeBytes: d.sizeBytes,
      kind: d.kind,
    })),
    expert: {
      name: fullNameOf(expertUser.firstName, expertUser.lastName, 'Your expert'),
      initials: initialsOf(expertUser.firstName, expertUser.lastName),
      // Not hydrated by `findByIdWithRelations` — degrade gracefully (the read
      // components omit these rows when null). Do NOT invent fields.
      company: null,
      headline: null,
      rating: null,
    },
  };

  // Admin lens ONLY: attach the fee/margin breakdown. Expert/client docs never get
  // this key (the audience-boundary invariant — asserted absent in the unit test).
  if (audience === 'admin') {
    doc.adminPricing = buildAdminPricing(proposal);
  }

  return doc;
}
