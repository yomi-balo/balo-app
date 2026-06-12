import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { ProposalDoc } from './proposal-doc';
import type { ProposalReviewDoc } from './proposal-review-types';

// The real viewer is a ssr:false dynamic Tiptap render — swap for a div that
// echoes its HTML. `isDescriptionEmpty` treats empty / whitespace HTML as empty
// so the milestone description block can hide.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextViewer: ({ value }: { value: string }) => <div data-testid="rt-viewer">{value}</div>,
  isDescriptionEmpty: (html: string) => html.replace(/<[^<>]*>/g, '').trim() === '',
}));

function baseDoc(overrides: Partial<ProposalReviewDoc> = {}): ProposalReviewDoc {
  return {
    id: 'prop-1',
    relationshipId: 'rel-1',
    version: 1,
    status: 'submitted',
    pricingMethod: 'fixed',
    overviewHtml: '<p>We will deliver CPQ.</p>',
    exclusionsHtml: '<p>Data migration is out of scope.</p>',
    priceCents: 1_000_000,
    currency: 'aud',
    timeframeWeeks: 6,
    depositCents: null,
    rateCents: null,
    cadence: null,
    milestones: [
      {
        id: 'm-1',
        title: 'Discovery',
        descriptionHtml: '<p>Workshops and design.</p>',
        acceptanceCriteria: 'Signed-off design doc',
        valueCents: 300_000,
      },
      {
        id: 'm-2',
        title: 'Build',
        descriptionHtml: null,
        acceptanceCriteria: null,
        valueCents: 700_000,
      },
    ],
    installments: [
      { id: 'i-1', label: 'Upfront', pct: 30 },
      { id: 'i-2', label: 'Final', pct: 70 },
    ],
    attachments: [],
    expert: {
      name: 'Priya Sharma',
      initials: 'PS',
      company: 'Cloudwerx',
      headline: 'CPQ Specialist',
      rating: 4.9,
    },
    ...overrides,
  };
}

describe('ProposalDoc — Fixed pricing', () => {
  it('renders the fixed price, per-milestone values, and the installment bar', () => {
    render(<ProposalDoc doc={baseDoc()} />);

    // 'Fixed price' appears twice: the method pill (header) + the banner label.
    expect(screen.getAllByText('Fixed price')).toHaveLength(2);
    expect(screen.getByText('A$10,000')).toBeInTheDocument();

    // Per-milestone values (Fixed only): 30% and 70% of A$10,000.
    expect(screen.getByText('A$3,000')).toBeInTheDocument();
    expect(screen.getByText('A$7,000')).toBeInTheDocument();

    // Installment percentages appear twice each (bar segment + per-row label).
    expect(screen.getAllByText('30%')).toHaveLength(2);
    expect(screen.getAllByText('70%')).toHaveLength(2);
    expect(screen.getByText(/Upfront — A\$3,000/)).toBeInTheDocument();
    expect(screen.getByText(/Final — A\$7,000/)).toBeInTheDocument();
  });

  it('shows the acceptance "Done when" line only when criteria is present', () => {
    render(<ProposalDoc doc={baseDoc()} />);
    expect(screen.getByText(/Signed-off design doc/)).toBeInTheDocument();
    // The second milestone has no acceptance criteria — only one "Done when" line.
    expect(screen.getAllByText(/Done when:/)).toHaveLength(1);
  });
});

describe('ProposalDoc — Time & materials', () => {
  function tmDoc(): ProposalReviewDoc {
    return baseDoc({
      pricingMethod: 'tm',
      priceCents: 800_000,
      depositCents: 600_000,
      rateCents: 25_000,
      cadence: 'monthly',
    });
  }

  it('renders deposit / rate / cadence and the estimate label, not per-milestone values', () => {
    render(<ProposalDoc doc={tmDoc()} />);

    // Estimated-total banner with the est. suffix.
    expect(screen.getByText('Estimated total')).toBeInTheDocument();
    expect(screen.getByText('est.')).toBeInTheDocument();

    // Real T&M fields.
    expect(screen.getByText(/A\$6,000 deposit on acceptance/)).toBeInTheDocument();
    expect(screen.getByText(/A\$250\/hr/)).toBeInTheDocument();
    expect(screen.getByText(/Invoiced monthly/)).toBeInTheDocument();
    expect(screen.getByText(/is an estimate, not a cap/)).toBeInTheDocument();

    // No per-milestone amounts in T&M.
    expect(screen.queryByText('A$3,000')).not.toBeInTheDocument();
    expect(screen.queryByText('A$7,000')).not.toBeInTheDocument();
  });

  it('guards null T&M fields without crashing', () => {
    render(
      <ProposalDoc
        doc={baseDoc({ pricingMethod: 'tm', depositCents: null, rateCents: null, cadence: null })}
      />
    );
    expect(screen.getByText(/is an estimate, not a cap/)).toBeInTheDocument();
    expect(screen.queryByText(/deposit on acceptance/)).not.toBeInTheDocument();
  });
});

describe('ProposalDoc — header + revision', () => {
  it('shows the revised pill only when version > 1', () => {
    const { rerender } = render(<ProposalDoc doc={baseDoc({ version: 1 })} />);
    expect(screen.queryByText(/revised/)).not.toBeInTheDocument();

    rerender(<ProposalDoc doc={baseDoc({ version: 3 })} />);
    expect(screen.getByText(/v3 · revised/)).toBeInTheDocument();
  });

  it('renders expert identity (name, company, rating, headline)', () => {
    render(<ProposalDoc doc={baseDoc()} />);
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText(/Cloudwerx/)).toBeInTheDocument();
    expect(screen.getByText(/4\.9/)).toBeInTheDocument();
    expect(screen.getByText(/CPQ Specialist/)).toBeInTheDocument();
  });
});

describe('ProposalDoc — attachments split + exclusions', () => {
  it('folds a kind:"terms" attachment into Terms, not Attachments', () => {
    render(
      <ProposalDoc
        doc={baseDoc({
          attachments: [{ id: 'a-1', fileName: 'msa.pdf', sizeBytes: 120_000, kind: 'terms' }],
        })}
      />
    );
    // Supplement row appears under Terms.
    expect(screen.getByText('msa.pdf')).toBeInTheDocument();
    expect(screen.getByText(/additional terms/)).toBeInTheDocument();
    // No Attachments section heading when there are no non-terms files.
    expect(screen.queryByText('Attachments')).not.toBeInTheDocument();
  });

  it('lists a non-terms attachment under Attachments', () => {
    render(
      <ProposalDoc
        doc={baseDoc({
          attachments: [
            { id: 'a-2', fileName: 'architecture.pdf', sizeBytes: 200_000, kind: 'ref' },
          ],
        })}
      />
    );
    expect(screen.getByText('Attachments')).toBeInTheDocument();
    expect(screen.getByText('architecture.pdf')).toBeInTheDocument();
  });

  it('hides "Not included" when exclusions are absent', () => {
    const { rerender } = render(<ProposalDoc doc={baseDoc()} />);
    expect(screen.getByText('Not included')).toBeInTheDocument();

    rerender(<ProposalDoc doc={baseDoc({ exclusionsHtml: null })} />);
    expect(screen.queryByText('Not included')).not.toBeInTheDocument();
  });
});

describe('ProposalDoc — section anchoring', () => {
  it('anchors sections with ids + scroll margin when sectionIdPrefix is given', () => {
    const { container } = render(<ProposalDoc doc={baseDoc()} sectionIdPrefix="sec-" />);
    const overview = container.querySelector('#sec-overview');
    expect(overview).not.toBeNull();
    expect(overview?.className).toContain('scroll-mt-20');
    expect(container.querySelector('#sec-milestones')).not.toBeNull();
    expect(container.querySelector('#sec-payment')).not.toBeNull();
    expect(container.querySelector('#sec-terms')).not.toBeNull();
  });

  it('renders the same content without ids when no prefix is given', () => {
    const { container } = render(<ProposalDoc doc={baseDoc()} />);
    expect(container.querySelector('#sec-overview')).toBeNull();
    // Content still renders.
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText(/Milestones/)).toBeInTheDocument();
  });
});
