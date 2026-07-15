import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@/test/utils';
import { SubmittedView } from './submitted-view';
import type { AdminProposalPricing, ProposalReviewDoc } from './proposal-review-types';

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
    render(
      <SubmittedView
        lens="expert"
        requestId="req-1"
        doc={doc()}
        clientName="Dana"
        otherProposalCount={2}
      />
    );
    expect(screen.getByText('Proposal sent to Dana')).toBeInTheDocument();
    expect(screen.getByText(/reviewing it alongside 2 others/)).toBeInTheDocument();
    // Expert lens gets the demoted back-channel.
    expect(screen.getByRole('button', { name: /Message Dana/ })).toBeInTheDocument();
  });

  it('omits the "alongside" clause when no other proposals exist (expert lens)', () => {
    render(
      <SubmittedView
        lens="expert"
        requestId="req-1"
        doc={doc()}
        clientName="Dana"
        otherProposalCount={0}
      />
    );
    expect(screen.getByText(/reviewing it\./)).toBeInTheDocument();
  });

  it('uses singular "other" for exactly one other proposal (expert lens)', () => {
    render(
      <SubmittedView
        lens="expert"
        requestId="req-1"
        doc={doc()}
        clientName="Dana"
        otherProposalCount={1}
      />
    );
    expect(screen.getByText(/reviewing it alongside 1 other\./)).toBeInTheDocument();
  });

  it('frames the wait for the admin lens and hides the back-channel', () => {
    render(
      <SubmittedView
        lens="admin"
        requestId="req-1"
        doc={doc()}
        clientName="Dana"
        otherProposalCount={1}
      />
    );
    // otherProposalCount + 1 total submitted.
    expect(screen.getByText('2 proposals submitted — client reviewing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Message Dana/ })).not.toBeInTheDocument();
  });

  it('renders the read-only proposal document', () => {
    render(
      <SubmittedView
        lens="expert"
        requestId="req-1"
        doc={doc()}
        clientName="Dana"
        otherProposalCount={0}
      />
    );
    expect(screen.getByText('Overview body text')).toBeInTheDocument();
  });
});

/** A populated admin pricing breakdown; deposit/rate are FIXED-null unless overridden. */
function adminPricing(overrides: Partial<AdminProposalPricing> = {}): AdminProposalPricing {
  return {
    baloFeeBps: 2500,
    expertPriceCents: 100_000,
    clientPriceCents: 125_000,
    marginCents: 25_000,
    expertDepositCents: null,
    clientDepositCents: null,
    expertRateCents: null,
    clientRateCents: null,
    ...overrides,
  };
}

/** Scope queries to the AdminPricingCard (avoids collisions with the ProposalDoc body). */
function pricingCard(): HTMLElement {
  const heading = screen.getByText('Pricing breakdown');
  const card = heading.closest('div');
  if (card === null) throw new Error('Pricing breakdown card not found');
  return card;
}

describe('SubmittedView — admin pricing breakdown (BAL-357)', () => {
  it('renders the fee/margin breakdown for the admin lens (FIXED — no deposit/rate rows)', () => {
    render(
      <SubmittedView
        lens="admin"
        requestId="req-1"
        doc={doc({ adminPricing: adminPricing() })}
        clientName="Dana"
        otherProposalCount={0}
      />
    );

    const card = within(pricingCard());
    // Core rows: expert quote (payout), Balo fee %, client price, margin.
    expect(card.getByText('Expert quote (payout)')).toBeInTheDocument();
    expect(card.getByText('A$1,000')).toBeInTheDocument();
    expect(card.getByText('Balo fee')).toBeInTheDocument();
    expect(card.getByText('25%')).toBeInTheDocument();
    expect(card.getByText('Client price (charged)')).toBeInTheDocument();
    expect(card.getByText('Balo margin')).toBeInTheDocument();

    // Emphasis ternary: client → text-primary, margin → text-success.
    expect(card.getByText('A$1,250')).toHaveClass('text-primary');
    expect(card.getByText('A$250')).toHaveClass('text-success');

    // FIXED case: both null-check branches skip → no deposit/rate lines.
    expect(card.queryByText(/Deposit \(expert → client\)/)).not.toBeInTheDocument();
    expect(card.queryByText(/Rate\/hr \(expert → client\)/)).not.toBeInTheDocument();
  });

  it('renders the deposit + rate "→" lines for the admin lens (T&M — non-null deposit/rate)', () => {
    render(
      <SubmittedView
        lens="admin"
        requestId="req-1"
        doc={doc({
          pricingMethod: 'tm',
          adminPricing: adminPricing({
            expertDepositCents: 20_000,
            clientDepositCents: 25_000,
            expertRateCents: 30_000,
            clientRateCents: 37_500,
          }),
        })}
        clientName="Dana"
        otherProposalCount={0}
      />
    );

    const card = within(pricingCard());
    // Both null-check branches taken → the expert → client both-sides lines render.
    expect(card.getByText('Deposit (expert → client)')).toBeInTheDocument();
    expect(card.getByText('A$200 → A$250')).toBeInTheDocument();
    expect(card.getByText('Rate/hr (expert → client)')).toBeInTheDocument();
    expect(card.getByText('A$300 → A$375')).toBeInTheDocument();
  });

  it('omits the pricing breakdown for the expert lens even when adminPricing is present', () => {
    render(
      <SubmittedView
        lens="expert"
        requestId="req-1"
        doc={doc({ adminPricing: adminPricing() })}
        clientName="Dana"
        otherProposalCount={0}
      />
    );
    expect(screen.queryByText('Pricing breakdown')).not.toBeInTheDocument();
  });

  it('omits the pricing breakdown for the admin lens when adminPricing is undefined', () => {
    render(
      <SubmittedView
        lens="admin"
        requestId="req-1"
        doc={doc()}
        clientName="Dana"
        otherProposalCount={0}
      />
    );
    expect(screen.queryByText('Pricing breakdown')).not.toBeInTheDocument();
  });
});
