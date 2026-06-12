import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { SubmittedView } from './submitted-view';
import type { ProposalReviewDoc } from './proposal-review-types';

vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextViewer: ({ value }: { value: string }) => <div data-testid="rt-viewer">{value}</div>,
  isDescriptionEmpty: (html: string) => html.replace(/<[^<>]*>/g, '').trim() === '',
}));

function doc(overrides: Partial<ProposalReviewDoc> = {}): ProposalReviewDoc {
  return {
    id: 'prop-1',
    relationshipId: 'rel-1',
    version: 1,
    status: 'submitted',
    pricingMethod: 'fixed',
    overviewHtml: 'Overview body text',
    exclusionsHtml: null,
    priceCents: 5_800_000,
    currency: 'aud',
    timeframeWeeks: 8,
    depositCents: null,
    rateCents: null,
    cadence: null,
    milestones: [],
    installments: [],
    attachments: [],
    expert: { name: 'Priya Sharma', initials: 'PS', company: 'Acme', headline: 'CPQ', rating: 4.9 },
    ...overrides,
  };
}

describe('SubmittedView', () => {
  it('frames the wait for the expert lens and shows the back-channel', () => {
    render(<SubmittedView lens="expert" doc={doc()} clientName="Dana" otherProposalCount={2} />);
    expect(screen.getByText('Proposal sent to Dana')).toBeInTheDocument();
    expect(screen.getByText(/reviewing it alongside 2 others/)).toBeInTheDocument();
    // Expert lens gets the demoted back-channel.
    expect(screen.getByRole('button', { name: /Message Dana/ })).toBeInTheDocument();
  });

  it('omits the "alongside" clause when no other proposals exist (expert lens)', () => {
    render(<SubmittedView lens="expert" doc={doc()} clientName="Dana" otherProposalCount={0} />);
    expect(screen.getByText(/reviewing it\./)).toBeInTheDocument();
  });

  it('uses singular "other" for exactly one other proposal (expert lens)', () => {
    render(<SubmittedView lens="expert" doc={doc()} clientName="Dana" otherProposalCount={1} />);
    expect(screen.getByText(/reviewing it alongside 1 other\./)).toBeInTheDocument();
  });

  it('frames the wait for the admin lens and hides the back-channel', () => {
    render(<SubmittedView lens="admin" doc={doc()} clientName="Dana" otherProposalCount={1} />);
    // otherProposalCount + 1 total submitted.
    expect(screen.getByText('2 proposals submitted — client reviewing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Message Dana/ })).not.toBeInTheDocument();
  });

  it('renders the read-only proposal document', () => {
    render(<SubmittedView lens="expert" doc={doc()} clientName="Dana" otherProposalCount={0} />);
    expect(screen.getByText('Overview body text')).toBeInTheDocument();
  });
});
