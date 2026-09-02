import { describe, it, expect, vi } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen } from '@/test/utils';

import PayoutLoading from './loading';
import PayoutError from './error';
import PayoutNotFound from './not-found';

describe('PayoutLoading', () => {
  it('announces itself as the expert-lens labelled loading region', () => {
    render(<PayoutLoading />);
    expect(screen.getByRole('status', { name: /Loading payout statement/ })).toBeInTheDocument();
  });
});

describe('PayoutError', () => {
  it('states the payout-scoped cause', () => {
    render(<PayoutError error={new Error('boom')} reset={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load this payout statement/i);
  });
});

describe('PayoutNotFound', () => {
  it('renders the payout-scoped not-found heading, not the receipt one', () => {
    render(<PayoutNotFound />);
    expect(
      screen.getByRole('heading', { name: "We couldn't find that payout" })
    ).toBeInTheDocument();
    expect(screen.queryByText("We couldn't find that receipt")).not.toBeInTheDocument();
  });
});

// ── Plan §15 required "no a11y violations" on each route state, and the sibling recap segment
// has exactly this (`meetings/[meetingId]/route-states.test.tsx`). These are two full-page money
// DOCUMENTS — card, <dl> line items, status badges, a live region — so an unlabelled control or
// a broken heading order here is a real defect on a surface people are told to forward.
describe('Payout route states — accessibility', () => {
  it('PayoutLoading has no accessibility violations', async () => {
    const { container } = render(<PayoutLoading />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('PayoutError has no accessibility violations', async () => {
    const { container } = render(<PayoutError error={new Error('x')} reset={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('PayoutNotFound has no accessibility violations', async () => {
    const { container } = render(<PayoutNotFound />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
