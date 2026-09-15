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
    expert: {
      name: 'Priya Sharma',
      initials: 'PS',
      company: 'Acme',
      headline: 'CPQ',
      rating: 4.9,
      ratingCount: 12,
    },
    ...overrides,
  };
}

describe('ReviewSummaryCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the at-a-glance summary rows', () => {
    render(<ReviewSummaryCard doc={doc()} onAccept={vi.fn()} onRequestChanges={vi.fn()} />);
    expect(screen.getByText("Priya's proposal")).toBeInTheDocument();
    expect(screen.getByText('Fixed price')).toBeInTheDocument();
    expect(screen.getByText('A$58,000')).toBeInTheDocument();
    expect(screen.getByText('~8 weeks')).toBeInTheDocument();
    // ⚠ BAL-392 F1 — Payment is `buildProposalSummaryCells`' derivation, NOT the card's old
    // `40% / 60%` percent join. The card must never restate money in its own words.
    expect(screen.getByText('40% upfront')).toBeInTheDocument();
  });

  it('fires onAccept when the accept CTA is clicked', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    render(<ReviewSummaryCard doc={doc()} onAccept={onAccept} onRequestChanges={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Accept this proposal' }));
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it('renders Request changes as an enabled action (no longer a disabled stub) and fires onRequestChanges', async () => {
    const user = userEvent.setup();
    const onRequestChanges = vi.fn();
    render(
      <ReviewSummaryCard doc={doc()} onAccept={vi.fn()} onRequestChanges={onRequestChanges} />
    );
    const requestChanges = screen.getByRole('button', { name: /Request changes/ });
    expect(requestChanges).toBeEnabled();
    expect(requestChanges).not.toHaveAttribute('aria-disabled');
    expect(requestChanges).not.toHaveAttribute('title', 'Available soon');

    await user.click(requestChanges);
    expect(onRequestChanges).toHaveBeenCalledOnce();
  });

  it('shows an Accepted state (no decision buttons) for an accepted doc', () => {
    render(
      <ReviewSummaryCard
        doc={doc({ status: 'accepted' })}
        onAccept={vi.fn()}
        onRequestChanges={vi.fn()}
      />
    );
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept this proposal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Request changes/ })).not.toBeInTheDocument();
  });

  it('labels the row Estimate and appends " est." for T&M', () => {
    render(
      <ReviewSummaryCard
        doc={doc({
          pricingMethod: 'tm',
          installments: [],
          cadence: 'monthly',
          depositCents: 500_000,
          rateCents: 25_000,
        })}
        onAccept={vi.fn()}
        onRequestChanges={vi.fn()}
      />
    );
    expect(screen.getByText('Estimate')).toBeInTheDocument();
    expect(screen.getByText('A$58,000 est.')).toBeInTheDocument();
    // ⚠ BAL-392 F1 — `Deposit + rate`, NOT the card's old `Deposit + {cadence}`. Cadence is
    // not an input to the shared derivation at all: what is DUE is what the row may claim.
    expect(screen.getByText('Deposit + rate')).toBeInTheDocument();
  });

  it('shows "Due in full" for a Fixed doc with no installments', () => {
    render(
      <ReviewSummaryCard
        doc={doc({ installments: [] })}
        onAccept={vi.fn()}
        onRequestChanges={vi.fn()}
      />
    );
    expect(screen.getByText('Payment')).toBeInTheDocument();
    expect(screen.getByText('Due in full')).toBeInTheDocument();
  });

  /**
   * ⚠ BAL-392 F1 — the four T&M payment states, on the CARD. Its predecessor asserted a
   * deposit unconditionally (`Deposit` / `Deposit + {cadence}`) off `cadence` alone, so a
   * proposal carrying NO deposit had the card claiming money was due that wasn't — beside
   * a grid saying otherwise, in one viewport, on the accept surface.
   */
  it.each([
    { deposit: 500_000, rate: 25_000, expected: 'Deposit + rate' },
    { deposit: null, rate: 25_000, expected: 'Rate only' },
    { deposit: 500_000, rate: null, expected: 'Deposit only' },
    { deposit: null, rate: null, expected: '—' },
  ])(
    'renders the T&M Payment row as "$expected" (deposit $deposit / rate $rate)',
    ({ deposit, rate, expected }) => {
      render(
        <ReviewSummaryCard
          doc={doc({
            pricingMethod: 'tm',
            installments: [],
            // ⚠ `cadence` stays SET in every row: it must not move the Payment string.
            cadence: 'monthly',
            depositCents: deposit,
            rateCents: rate,
          })}
          onAccept={vi.fn()}
          onRequestChanges={vi.fn()}
        />
      );
      expect(screen.getByText(expected)).toBeInTheDocument();
      expect(screen.queryByText(/monthly/)).not.toBeInTheDocument();
    }
  );

  it('appends a "· v2" pill to the heading for a revised (version 2) doc', () => {
    render(
      <ReviewSummaryCard doc={doc({ version: 2 })} onAccept={vi.fn()} onRequestChanges={vi.fn()} />
    );
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
            // ⚠ UNRATED: null, and `ratingCount` 0 — the card must render NEITHER, never 0.0.
            rating: null,
            ratingCount: 0,
          },
        })}
        onAccept={vi.fn()}
        onRequestChanges={vi.fn()}
      />
    );
    expect(screen.getByText("Priya's proposal")).toBeInTheDocument();
    // Neither the rating value nor the company string renders.
    expect(screen.queryByText('4.9')).not.toBeInTheDocument();
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
    // ⚠ AND NO FABRICATED ZERO, AND NO ORPHANED COUNT.
    expect(screen.queryByText('0.0')).not.toBeInTheDocument();
    expect(screen.queryByText('(0)')).not.toBeInTheDocument();
  });

  /**
   * ⚠ BAL-422 AC — THE AVERAGE NEVER SHIPS WITHOUT ITS DENOMINATOR. This card rendered a bare
   * average with NO count before.
   */
  it('renders the rating to one decimal WITH its review count', () => {
    render(<ReviewSummaryCard doc={doc()} onAccept={vi.fn()} onRequestChanges={vi.fn()} />);
    // ⚠ EXACT, NOT `/4\.9/`: the `sr-only` accessible name contains the same digits, so a
    // regex would match two nodes and throw. Asserted separately, below.
    expect(screen.getByText('4.9')).toBeInTheDocument();
    expect(screen.getByText('(12)')).toBeInTheDocument();
  });

  /** ⚠ …AND THE DENOMINATOR REACHES A SCREEN READER AS "ENGAGEMENTS", not as a bare "12". */
  it('gives the rating an accessible name that says engagements', () => {
    render(<ReviewSummaryCard doc={doc()} onAccept={vi.fn()} onRequestChanges={vi.fn()} />);
    expect(screen.getByText('Rated 4.9 out of 5 across 12 engagements')).toBeInTheDocument();
  });
});
