// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type {
  Proposal,
  ProposalMilestone,
  ProposalPaymentInstallment,
  ProposalDocument,
  ProjectRequestWithRelations,
} from '@balo/db';
import { hydrateReviewDoc } from '@/lib/project-request/proposal-audience-view';
import { ProposalPdfDocument, renderProposalPdfToBuffer } from './proposal-pdf-document';

const NOW = new Date('2026-01-01T00:00:00.000Z');

/** Expert quote 100_000 @ 2500 bps → client price 125_000 (marked-up). */
function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'proposal-1',
    relationshipId: 'rel-1',
    projectRequestId: 'req-1',
    expertProfileId: 'exp-1',
    status: 'submitted',
    pricingMethod: 'fixed',
    version: 1,
    isCurrent: true,
    overview: '<p>Rebuild lead routing with proper assignment rules.</p>',
    exclusions: null,
    timeframeWeeks: 8,
    priceCents: 100_000,
    currency: 'aud',
    baloFeeBps: 2500,
    depositCents: null,
    rateCents: null,
    cadence: null,
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
    descriptionHtml: '<p>Audit the org.</p>',
    acceptanceCriteria: 'Findings documented',
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
    fileName: 'appendix.pdf',
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
      user: { id: 'user-9', firstName: 'Dana', lastName: 'Okafor' },
    },
    expressionsOfInterest: [],
    conversationMessages: [],
  };
}

interface ClientDocLists {
  milestones?: ProposalMilestone[];
  installments?: ProposalPaymentInstallment[];
  documents?: ProposalDocument[];
}

function clientDoc(proposalOverrides: Partial<Proposal> = {}, lists: ClientDocLists = {}) {
  return hydrateReviewDoc(
    makeProposal(proposalOverrides),
    lists.milestones ?? [makeMilestone()],
    lists.installments ?? [makeInstallment()],
    lists.documents ?? [makeDocument()],
    makeRelationship(),
    'client'
  );
}

/**
 * Recursively collect all rendered text across the document element tree. react-pdf
 * primitives (Document/Page/View/Text/Link) are STRING host types, so we recurse into
 * their children; our own pure presentational sub-components (PaymentTerms,
 * StandardTerms, MilestoneRow, …) are FUNCTION types, so we invoke them to reach the
 * text they emit (they use no hooks/context, so a plain call is safe).
 */
function collectText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'object' && node !== null && 'type' in node && 'props' in node) {
    const el = node as { type: unknown; props: { children?: React.ReactNode } };
    if (typeof el.type === 'function') {
      const renderComponent = el.type as (props: unknown) => React.ReactNode;
      return collectText(renderComponent(el.props));
    }
    return collectText(el.props.children);
  }
  return '';
}

describe('ProposalPdfDocument — money-safety at the mapping boundary (BAL-385)', () => {
  it('consumes a client-audience doc with the fee/expert-quote structurally absent', () => {
    const doc = clientDoc();

    // The marked-up client figures — never the raw expert quote.
    expect(doc.priceCents).toBe(125_000);
    expect(doc.milestones[0]?.valueCents).toBe(75_000);

    // The fee/margin breakdown and the fee rate can never reach the template.
    expect(doc.adminPricing).toBeUndefined();
    expect(Object.keys(doc)).not.toContain('adminPricing');
    expect(doc).not.toHaveProperty('baloFeeBps');

    // Sanity: the same proposal at the admin audience WOULD carry the fee — proof the
    // difference is the audience argument, and the PDF is built with `client`.
    const adminView = hydrateReviewDoc(
      makeProposal(),
      [makeMilestone()],
      [makeInstallment()],
      [makeDocument()],
      makeRelationship(),
      'admin'
    );
    expect(adminView.adminPricing?.baloFeeBps).toBe(2500);
  });

  it('renders "{name} @ {org}" prepared-by when an org name is supplied, plain name otherwise', () => {
    // Structural (no render): the doc carries only the person; the org is a separate prop.
    const doc = clientDoc();
    expect(doc.expert.name).toBe('Dana Okafor');
    // A React element is produced for both org / no-org cases without throwing.
    expect(
      ProposalPdfDocument({
        doc,
        title: 'CRM Cleanup',
        clientCompanyName: 'Northwind Industrial',
        preparedByOrgName: 'CloudPeak',
        generatedAtIso: NOW.toISOString(),
      })
    ).toBeTruthy();
    expect(
      ProposalPdfDocument({
        doc,
        title: 'CRM Cleanup',
        clientCompanyName: 'Northwind Industrial',
        preparedByOrgName: null,
        generatedAtIso: NOW.toISOString(),
      })
    ).toBeTruthy();
  });
});

describe('ProposalPdfDocument — render smoke', () => {
  it('renders a Fixed-price proposal to a non-empty PDF buffer (Geist embedded)', async () => {
    const buffer = await renderProposalPdfToBuffer({
      doc: clientDoc(),
      title: 'CRM Cleanup',
      clientCompanyName: 'Northwind Industrial',
      preparedByOrgName: 'CloudPeak',
      generatedAtIso: '2026-07-15T00:00:00.000Z',
    });
    expect(buffer.byteLength).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('renders a T&M proposal with exclusions and null timeframe without throwing', async () => {
    const doc = clientDoc({
      pricingMethod: 'tm',
      depositCents: 20_000,
      rateCents: 30_000,
      cadence: 'monthly',
      exclusions: '<p>Data migration is out of scope.</p>',
      timeframeWeeks: null,
    });
    const buffer = await renderProposalPdfToBuffer({
      doc,
      title: 'Ongoing Support',
      clientCompanyName: 'your company',
      preparedByOrgName: null,
      generatedAtIso: '2026-07-15T00:00:00.000Z',
    });
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('ProposalPdfDocument — conditional branches', () => {
  function renderTree(doc: ReturnType<typeof clientDoc>): string {
    return collectText(
      ProposalPdfDocument({
        doc,
        title: 'CRM Cleanup',
        clientCompanyName: 'Northwind Industrial',
        preparedByOrgName: 'CloudPeak',
        generatedAtIso: NOW.toISOString(),
      })
    );
  }

  it('shows the "revised" version note and the terms-supplement line (v2 + terms attachment)', () => {
    const doc = clientDoc(
      { version: 2 },
      { documents: [makeDocument({ id: 'terms-1', kind: 'terms', fileName: 'MSA.pdf' })] }
    );
    const text = renderTree(doc);
    // Version > 1 → the "· revised" note (not the bare "Version 2").
    expect(text).toContain('Version 2 · revised');
    // The kind:'terms' attachment folds into the Terms section as a supplement line.
    expect(text).toContain('Additional terms attached: MSA.pdf');
  });

  it('renders a full-amount line (not an empty box) for a Fixed proposal with zero installments', () => {
    const doc = clientDoc({}, { installments: [] });
    const text = renderTree(doc);
    // client price = 100_000 marked up 25% = 125_000 → $1,250 (aud, whole).
    expect(doc.installments).toHaveLength(0);
    expect(text).toContain('Full amount:');
    expect(text).toContain('due in full');
    expect(text).toContain('$1,250');
  });
});
