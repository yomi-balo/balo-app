import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ReviewSummaryCard } from './review-summary-card';
import type { ProposalReviewDoc } from './proposal-review-types';

function doc(overrides: Partial<ProposalReviewDoc> = {}): ProposalReviewDoc {
  return {
    id: 'prop-1',
    relationshipId: 'rel-1',
    version: 1,
    status: 'submitted',
    pricingMethod: 'fixed',
    overviewHtml: '<p>Overview</p>',
    exclusionsHtml: null,
    priceCents: 5_800_000,
    currency: 'aud',
    timeframeWeeks: 8,
    depositCents: null,
    rateCents: null,
    cadence: null,
    milestones: [
      {
        id: 'm',
        title: 'Build',
        descriptionHtml: null,
        acceptanceCriteria: null,
        valueCents: null,
      },
    ],
    installments: [
      { id: 'i-1', label: 'Upfront', pct: 40 },
      { id: 'i-2', label: 'On delivery', pct: 60 },
    ],
    attachments: [],
    expert: { name: 'Priya Sharma', initials: 'PS', company: 'Acme', headline: 'CPQ', rating: 4.9 },
    ...overrides,
  };
}

describe('ReviewSummaryCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the at-a-glance summary rows', () => {
    render(<ReviewSummaryCard doc={doc()} onAccept={vi.fn()} />);
    expect(screen.getByText("Priya's proposal")).toBeInTheDocument();
    expect(screen.getByText('Fixed price')).toBeInTheDocument();
    expect(screen.getByText('A$58,000')).toBeInTheDocument();
    expect(screen.getByText('~8 weeks')).toBeInTheDocument();
    expect(screen.getByText('40% / 60%')).toBeInTheDocument();
  });

  it('fires onAccept when the accept CTA is clicked', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    render(<ReviewSummaryCard doc={doc()} onAccept={onAccept} />);
    await user.click(screen.getByRole('button', { name: 'Accept this proposal' }));
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it('renders Request changes as a disabled stub', () => {
    render(<ReviewSummaryCard doc={doc()} onAccept={vi.fn()} />);
    const requestChanges = screen.getByRole('button', { name: /Request changes/ });
    expect(requestChanges).toBeDisabled();
    expect(requestChanges).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows an Accepted state (no decision buttons) for an accepted doc', () => {
    render(<ReviewSummaryCard doc={doc({ status: 'accepted' })} onAccept={vi.fn()} />);
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept this proposal' })).not.toBeInTheDocument();
  });

  it('labels the row Estimate and appends " est." for T&M', () => {
    render(
      <ReviewSummaryCard
        doc={doc({ pricingMethod: 'tm', installments: [], cadence: 'monthly' })}
        onAccept={vi.fn()}
      />
    );
    expect(screen.getByText('Estimate')).toBeInTheDocument();
    expect(screen.getByText('A$58,000 est.')).toBeInTheDocument();
    expect(screen.getByText('Deposit + monthly')).toBeInTheDocument();
  });

  it('shows a "—" Payment row for a Fixed doc with no installments', () => {
    render(<ReviewSummaryCard doc={doc({ installments: [] })} onAccept={vi.fn()} />);
    expect(screen.getByText('Payment')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows a bare "Deposit" Payment row for a T&M doc with no cadence', () => {
    render(
      <ReviewSummaryCard
        doc={doc({ pricingMethod: 'tm', installments: [], cadence: null })}
        onAccept={vi.fn()}
      />
    );
    expect(screen.getByText('Deposit')).toBeInTheDocument();
    expect(screen.queryByText(/Deposit \+/)).not.toBeInTheDocument();
  });

  it('appends a "· v2" pill to the heading for a revised (version 2) doc', () => {
    render(<ReviewSummaryCard doc={doc({ version: 2 })} onAccept={vi.fn()} />);
    expect(screen.getByText(/Priya's proposal · v2/)).toBeInTheDocument();
  });

  it('omits the rating/company sub-line when both are null', () => {
    render(
      <ReviewSummaryCard
        doc={doc({
          expert: {
            name: 'Priya Sharma',
            initials: 'PS',
            company: null,
            headline: 'CPQ',
            rating: null,
          },
        })}
        onAccept={vi.fn()}
      />
    );
    expect(screen.getByText("Priya's proposal")).toBeInTheDocument();
    // Neither the rating value nor the company string renders.
    expect(screen.queryByText('4.9')).not.toBeInTheDocument();
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
  });
});
