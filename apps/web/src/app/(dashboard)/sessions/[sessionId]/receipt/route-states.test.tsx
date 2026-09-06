import { describe, it, expect, vi } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen } from '@/test/utils';

import ReceiptLoading from './loading';
import ReceiptError from './error';
import ReceiptNotFound from './not-found';
import { StatementRateLimited } from '../_components/statement-rate-limited';

describe('ReceiptLoading', () => {
  it('announces itself as the client-lens labelled loading region', () => {
    render(<ReceiptLoading />);
    expect(screen.getByRole('status', { name: /Loading receipt/ })).toBeInTheDocument();
  });
});

describe('ReceiptError', () => {
  it('states the receipt-scoped cause', () => {
    render(<ReceiptError error={new Error('boom')} reset={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load this receipt/i);
  });
});

describe('ReceiptNotFound', () => {
  it('renders the receipt-scoped not-found heading, not the payout one', () => {
    render(<ReceiptNotFound />);
    expect(
      screen.getByRole('heading', { name: "We couldn't find that receipt" })
    ).toBeInTheDocument();
    expect(screen.queryByText("We couldn't find that payout")).not.toBeInTheDocument();
  });
});

// ── Plan §15 required "no a11y violations" on each route state, and the sibling recap segment
// has exactly this (`meetings/[meetingId]/route-states.test.tsx`). These are two full-page money
// DOCUMENTS — card, <dl> line items, status badges, a live region — so an unlabelled control or
// a broken heading order here is a real defect on a surface people are told to forward.
describe('Receipt route states — accessibility', () => {
  it('ReceiptLoading has no accessibility violations', async () => {
    const { container } = render(<ReceiptLoading />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('ReceiptError has no accessibility violations', async () => {
    const { container } = render(<ReceiptError error={new Error('x')} reset={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('ReceiptNotFound has no accessibility violations', async () => {
    const { container } = render(<ReceiptNotFound />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('StatementRateLimited has no accessibility violations', async () => {
    const { container } = render(
      <StatementRateLimited lens="client" sessionId="a0000000-0000-4000-8000-000000000001" />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
