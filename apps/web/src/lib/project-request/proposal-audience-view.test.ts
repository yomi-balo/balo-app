import { describe, it, expect } from 'vitest';
import type {
  Proposal,
  ProposalMilestone,
  ProposalPaymentInstallment,
  ProposalDocument,
  ProjectRequestWithRelations,
} from '@balo/db';
import { hydrateReviewDoc } from './proposal-audience-view';

/**
 * BAL-357 audience-boundary invariant. The serializer resolves money per audience
 * and NEVER leaks the Balo fee rate to expert/client docs. The idioms below
 * (`Object.keys` allow-list check + `.not.toHaveProperty` at every level) mirror
 * the leak-guard precedent in `engagements.integration.test.ts`.
 */

const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'proposal-1',
    relationshipId: 'rel-1',
    projectRequestId: 'req-1',
    expertProfileId: 'exp-1',
    status: 'submitted',
    pricingMethod: 'tm',
    version: 1,
    isCurrent: true,
    overview: '<p>Overview</p>',
    exclusions: null,
    timeframeWeeks: 6,
    priceCents: 100_000,
    currency: 'aud',
    baloFeeBps: 2500,
    depositCents: 40_000,
    rateCents: 20_000,
    cadence: 'monthly',
    submittedAt: NOW,
    acceptedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeMilestone(overrides: Partial<ProposalMilestone> = {}): ProposalMilestone {
  return {
    id: 'ms-1',
    proposalId: 'proposal-1',
    sortOrder: 0,
    title: 'Discovery',
    descriptionHtml: null,
    acceptanceCriteria: null,
    valueCents: 60_000,
    estimatedMinutes: 120,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeInstallment(
  overrides: Partial<ProposalPaymentInstallment> = {}
): ProposalPaymentInstallment {
  return {
    id: 'inst-1',
    proposalId: 'proposal-1',
    sortOrder: 0,
    label: 'Upfront',
    pct: 40,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeDocument(overrides: Partial<ProposalDocument> = {}): ProposalDocument {
  return {
    id: 'doc-1',
    proposalId: 'proposal-1',
    uploadedByUserId: 'user-1',
    kind: 'ref',
    r2Key: 'r2/doc-1',
    fileName: 'brief.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

type Relationship = ProjectRequestWithRelations['relationships'][number];

function makeRelationship(): Relationship {
  return {
    id: 'rel-1',
    expertProfileId: 'exp-1',
    status: 'proposal_submitted',
    invitedAt: NOW,
    updatedAt: NOW,
    expertProfile: {
      id: 'exp-1',
      // ⚠ `rating_average` is `numeric(2,1)`, so Drizzle's relational `columns:` hands back
      // the STRING '4.3'. The fixture mirrors the raw row precisely so the mapper's
      // `parseRatingAverage` is genuinely exercised rather than bypassed by a pre-parsed
      // number — that string→number seam is the whole trap this feature had to avoid.
      ratingAverage: '4.3',
      ratingCount: 2,
      user: { id: 'user-9', firstName: 'Priya', lastName: 'Sharma' },
    },
    expressionsOfInterest: [],
    conversationMessages: [],
  };
}

const proposal = makeProposal();
const milestones = [makeMilestone()];
const installments = [makeInstallment()];
const documents = [makeDocument()];
const relationship = makeRelationship();

/**
 * BAL-422 — the expert's rating is now hydrated from the relationship graph rather than
 * degrading to `null`. The parse is the point: `findByIdWithRelations` uses a relational
 * `columns:` allow-list, which cannot reshape a `numeric(2,1)` column, so the raw row carries
 * the STRING `'4.3'` and the mapper must turn it into a number.
 */
describe('hydrateReviewDoc — the expert rating aggregate', () => {
  const hydrate = (rel = relationship) =>
    hydrateReviewDoc(proposal, milestones, installments, documents, rel, 'client');

  it('parses the numeric rating STRING into a number and carries the count', () => {
    const doc = hydrate();
    expect(doc.expert.rating).toBe(4.3);
    expect(typeof doc.expert.rating).toBe('number');
    expect(doc.expert.ratingCount).toBe(2);
  });

  /** ⚠ NULL MEANS NO REVIEWS — never coalesced to 0, which would fabricate a bad score. */
  it('keeps an unrated expert null, and never fabricates a zero', () => {
    const unrated = {
      ...relationship,
      expertProfile: {
        ...relationship.expertProfile,
        ratingAverage: null,
        ratingCount: 0,
      },
    };

    const doc = hydrate(unrated);
    expect(doc.expert.rating).toBeNull();
    expect(doc.expert.ratingCount).toBe(0);
  });

  /**
   * ⚠ THE RATING IS AUDIENCE-INDEPENDENT. Unlike money, it is not marked up, concealed or
   * re-keyed per audience — the same aggregate is public on the expert's card.
   */
  it('is identical across every audience', () => {
    const ratings = (['client', 'expert', 'admin'] as const).map(
      (audience) =>
        hydrateReviewDoc(proposal, milestones, installments, documents, relationship, audience)
          .expert
    );
    for (const expert of ratings) {
      expect(expert.rating).toBe(4.3);
      expect(expert.ratingCount).toBe(2);
    }
  });
});

describe('hydrateReviewDoc — audience boundary (BAL-357)', () => {
  it('expert: raw figures, no adminPricing, no fee rate at any level', () => {
    const doc = hydrateReviewDoc(
      proposal,
      milestones,
      installments,
      documents,
      relationship,
      'expert'
    );

    // Raw expert quote passes through untouched.
    expect(doc.priceCents).toBe(100_000);
    expect(doc.depositCents).toBe(40_000);
    expect(doc.rateCents).toBe(20_000);
    expect(doc.milestones[0]?.valueCents).toBe(60_000);

    // No admin breakdown, no fee rate — structurally absent at every level.
    expect(Object.keys(doc)).not.toContain('adminPricing');
    expect(doc).not.toHaveProperty('adminPricing');
    expect(doc).not.toHaveProperty('baloFeeBps');
    expect(doc.milestones[0]).not.toHaveProperty('baloFeeBps');
    expect(doc.installments[0]).not.toHaveProperty('baloFeeBps');
    expect(doc.expert).not.toHaveProperty('baloFeeBps');
  });

  it('client: every money figure marked up, no adminPricing, no fee rate', () => {
    const doc = hydrateReviewDoc(
      proposal,
      milestones,
      installments,
      documents,
      relationship,
      'client'
    );

    // applyBaloFee(x, 2500) grosses up by 25%.
    expect(doc.priceCents).toBe(125_000);
    expect(doc.depositCents).toBe(50_000);
    expect(doc.rateCents).toBe(25_000);
    expect(doc.milestones[0]?.valueCents).toBe(75_000);
    // Installments stay pct-only (amounts derive downstream from priceCents).
    expect(doc.installments[0]?.pct).toBe(40);

    expect(Object.keys(doc)).not.toContain('adminPricing');
    expect(doc).not.toHaveProperty('adminPricing');
    expect(doc).not.toHaveProperty('baloFeeBps');
    expect(doc.milestones[0]).not.toHaveProperty('baloFeeBps');
    expect(doc.installments[0]).not.toHaveProperty('baloFeeBps');
    expect(doc.expert).not.toHaveProperty('baloFeeBps');
  });

  it('admin: raw base figures PLUS an adminPricing breakdown with both sides + margin', () => {
    const doc = hydrateReviewDoc(
      proposal,
      milestones,
      installments,
      documents,
      relationship,
      'admin'
    );

    // Admin base body stays the raw expert quote.
    expect(doc.priceCents).toBe(100_000);
    expect(doc.depositCents).toBe(40_000);
    expect(doc.rateCents).toBe(20_000);
    expect(doc.milestones[0]?.valueCents).toBe(60_000);

    // The fee/margin breakdown is present — admin only.
    expect(Object.keys(doc)).toContain('adminPricing');
    expect(doc.adminPricing).toBeDefined();
    expect(doc.adminPricing?.baloFeeBps).toBe(2500);
    expect(doc.adminPricing?.expertPriceCents).toBe(100_000);
    expect(doc.adminPricing?.clientPriceCents).toBe(125_000);
    expect(doc.adminPricing?.marginCents).toBe(25_000);
    expect(doc.adminPricing?.expertDepositCents).toBe(40_000);
    expect(doc.adminPricing?.clientDepositCents).toBe(50_000);
    expect(doc.adminPricing?.expertRateCents).toBe(20_000);
    expect(doc.adminPricing?.clientRateCents).toBe(25_000);

    // The fee rate never appears as a top-level doc field.
    expect(doc).not.toHaveProperty('baloFeeBps');
  });

  it('client: null-safe markup leaves null deposit/rate/milestone values null', () => {
    const nullTerms = makeProposal({ depositCents: null, rateCents: null });
    const nullMilestone = [makeMilestone({ valueCents: null })];
    const doc = hydrateReviewDoc(
      nullTerms,
      nullMilestone,
      installments,
      documents,
      relationship,
      'client'
    );

    expect(doc.depositCents).toBeNull();
    expect(doc.rateCents).toBeNull();
    expect(doc.milestones[0]?.valueCents).toBeNull();
    // The total still marks up.
    expect(doc.priceCents).toBe(125_000);
  });

  it('admin: null-safe breakdown carries null client deposit/rate when the raw terms are null', () => {
    const nullTerms = makeProposal({ depositCents: null, rateCents: null });
    const doc = hydrateReviewDoc(
      nullTerms,
      milestones,
      installments,
      documents,
      relationship,
      'admin'
    );

    expect(doc.adminPricing?.expertDepositCents).toBeNull();
    expect(doc.adminPricing?.clientDepositCents).toBeNull();
    expect(doc.adminPricing?.expertRateCents).toBeNull();
    expect(doc.adminPricing?.clientRateCents).toBeNull();
  });
});
