import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import Loading from './loading';

describe('CreditsBillingPage loading skeleton', () => {
  it('renders the wallet widget loading state plus the BAL-516 picker + card-row skeletons', () => {
    render(<Loading />);

    // WalletWidget's own loading arm (unchanged, BAL-503).
    expect(screen.getAllByLabelText(/Loading/i).length).toBeGreaterThan(0);

    // The BAL-516 picker-shaped skeleton (SectionSkeleton, three pulsing rows).
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    // The BAL-516 card-row skeleton.
    expect(screen.getByTestId('saved-card-row-skeleton')).toBeInTheDocument();
  });
});
