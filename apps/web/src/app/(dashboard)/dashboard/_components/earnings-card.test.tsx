import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { EarningsCard } from './earnings-card';

describe('EarningsCard', () => {
  it('shows the three placeholder lines at A$0.00', () => {
    render(<EarningsCard />);
    for (const label of ['Pending transfer', 'This payout cycle', 'Total earnings']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByText('A$0.00')).toHaveLength(3);
  });

  it('links to the payouts settings tab', () => {
    render(<EarningsCard />);
    expect(screen.getByRole('link', { name: /view payouts/i })).toHaveAttribute(
      'href',
      '/expert/settings?tab=payouts'
    );
  });
});
