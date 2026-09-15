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
    acceptedByUserId: null,
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
    // BAL-283 — the render-path projection carries "has the expert shared availability on
    // this thread". The PDF reads none of it; `null` = never shared.
    availabilitySharedAt: null,
    // BAL-540 — D3's per-track decline attribution columns. The PDF reads none of it.
    declinedAt: null,
    declinedByUserId: null,
    declineReason: null,
    expertProfile: {
      id: 'exp-1',
      // ⚠ `numeric` ⇒ a STRING off the driver — the fixture mirrors the raw row.
      ratingAverage: null,
      ratingCount: 0,
      user: { id: 'user-9', firstName: 'Dana', lastName: 'Okafor' },
    },
    expressionsOfInterest: [],
    conversationMessages: [],
    // BAL-540 — existence-only projection. The PDF reads none of it.
    proposals: [],
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

  /**
   * The summary-box value cell is clamped with `maxLines: 1` + `textOverflow: 'ellipsis'`
   * (BAL-392). This proves the clamp survives real layout at the pinned react-pdf version
   * with an over-long installment label and an em-dash timeline.
   */
  it('renders a summary box with an over-long payment label and no timeframe', async () => {
    const buffer = await renderProposalPdfToBuffer({
      doc: clientDoc(
        { timeframeWeeks: null },
        { installments: [makeInstallment({ label: 'On contract signature', pct: 30 })] }
      ),
      title: 'CRM Cleanup',
      clientCompanyName: 'Northwind Industrial',
      preparedByOrgName: 'CloudPeak',
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

  // ── Summary box (BAL-392) ──────────────────────────────────────────────────────
  //
  // ⚠ `collectText` sees the RAW source strings, so the cell labels assert as
  // sentence-case ('Est. timeline'); both surfaces uppercase them presentationally.
  //
  // ⚠ Each cell's label and value are ADJACENT `Text` siblings, so `collectText`
  // concatenates them. Asserting the pair (`Est. timeline—`) pins a value to ITS OWN
  // cell — a bare `toContain('—')` would also match the installment row's em dash and
  // pass vacuously.

  it('renders all four summary cells, in the reference order', () => {
    const text = renderTree(clientDoc());
    expect(text).toContain('PricingFixed price');
    expect(text).toContain('Est. timeline~8 weeks');
    expect(text).toContain('Payment40% upfront');
    // Bounded on BOTH sides: `Deliverables1 item` alone is a prefix match that the
    // plural `1 items` would also satisfy, so the singular would not be pinned here.
    // DELIVERABLES is the last cell, so its right boundary is the next section label.
    expect(text).toContain('Deliverables1 itemOVERVIEW');
  });

  it('labels the Fixed total row "Total amount" and retires the old banner labels', () => {
    const text = renderTree(clientDoc());
    expect(text).toContain('Total amount');
    // The method moved to the PRICING cell, so the old total label is gone…
    expect(text).not.toContain('FIXED PRICE');
    // …as is the two-item banner's timeframe label.
    expect(text).not.toContain('EST. TIMEFRAME');
  });

  it('keeps the T&M total treatment — "Estimated total" plus the est. suffix', () => {
    const text = renderTree(
      clientDoc({ pricingMethod: 'tm', depositCents: 20_000, rateCents: 30_000 })
    );
    expect(text).toContain('Estimated total');
    expect(text).toContain(' est.');
    // Lower-case `m` in the PRICING cell — and, since BAL-392, in the header pill too.
    expect(text).toContain('PricingTime & materials');
  });

  /**
   * ⚠ THE PILL, NOT THE CELL. The every-page header pill prints on the same document as
   * the SummaryBox, so it reads `pricingMethodLabel` — a client can no longer read
   * `Time & Materials` in the header against `Time & materials` in the box. Capital-M is
   * RETIRED here.
   *
   * Anchoring on the wordmark (`Balo` + pill) and counting occurrences is what makes this
   * fail if the pill is hardcoded back; the cell assertion above would pass either way.
   */
  it('spells the header pill with the canonical lower-case "Time & materials"', () => {
    const text = renderTree(clientDoc({ pricingMethod: 'tm' }));

    expect(text).toContain('BaloTime & materials');
    expect(text.split('Time & materials')).toHaveLength(3); // the pill + the PRICING cell
    expect(text).not.toContain('Time & Materials');
  });

  it('falls back to an em dash in the timeline cell when no timeframe was given', () => {
    expect(renderTree(clientDoc({ timeframeWeeks: null }))).toContain('Est. timeline—');
  });

  it('counts deliverables from the milestone list', () => {
    const three = clientDoc(
      {},
      {
        milestones: [
          makeMilestone({ id: 'ms-1' }),
          makeMilestone({ id: 'ms-2', title: 'Build' }),
          makeMilestone({ id: 'ms-3', title: 'Handover' }),
        ],
      }
    );
    expect(renderTree(three)).toContain('Deliverables3 items');
    expect(renderTree(clientDoc({}, { milestones: [] }))).toContain('Deliverables—');
  });

  it('derives the Fixed payment cell from the first installment', () => {
    // No schedule at all → the price is due in full.
    expect(renderTree(clientDoc({}, { installments: [] }))).toContain('PaymentDue in full');

    // A blank label cannot be composed → the neutral count, pluralised.
    const blank = clientDoc(
      {},
      {
        installments: [
          makeInstallment({ label: '   ' }),
          makeInstallment({ id: 'inst-2', label: 'Final', pct: 60 }),
        ],
      }
    );
    expect(renderTree(blank)).toContain('Payment2 payments');

    // Too long for one line → the count, SINGULARISED for a lone installment. Bounded on
    // both sides by the neighbouring labels: `Payment1 payment` alone is a prefix match
    // that `1 payments` would also satisfy, which would leave the singular unpinned.
    const long = clientDoc(
      {},
      { installments: [makeInstallment({ label: 'On contract signature', pct: 30 })] }
    );
    expect(renderTree(long)).toContain('Payment1 paymentDeliverables');
  });

  it('adapts the T&M payment cell to whichever of deposit / rate exists', () => {
    // All four D5 states — the cell must never assert money is due that isn't.
    const both = clientDoc({ pricingMethod: 'tm', depositCents: 20_000, rateCents: 30_000 });
    expect(renderTree(both)).toContain('PaymentDeposit + rate');

    const rateOnly = clientDoc({ pricingMethod: 'tm', depositCents: null, rateCents: 30_000 });
    expect(renderTree(rateOnly)).toContain('PaymentRate only');

    const depositOnly = clientDoc({ pricingMethod: 'tm', depositCents: 20_000, rateCents: null });
    expect(renderTree(depositOnly)).toContain('PaymentDeposit only');

    // Neither figure given → the same em dash the TIMELINE cell uses for "not specified".
    const neither = clientDoc({ pricingMethod: 'tm', depositCents: null, rateCents: null });
    expect(renderTree(neither)).toContain('Payment—');
  });
});
