import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import Loading from './loading';

describe('CreditsBillingPage loading skeleton', () => {
  it('renders the wallet widget loading state plus the BAL-516 picker + card-row skeletons and the BAL-522 billing-email skeleton', () => {
    const { container } = render(<Loading />);

    // WalletWidget's own loading arm (unchanged, BAL-503).
    expect(screen.getAllByLabelText(/Loading/i).length).toBeGreaterThan(0);

    // The BAL-516 picker-shaped skeleton (SectionSkeleton, three pulsing rows).
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    // The BAL-516 card-row skeleton.
    expect(screen.getByTestId('saved-card-row-skeleton')).toBeInTheDocument();

    // The BAL-522 billing-email skeleton — same card shell as `BillingEmailSection`, holding a
    // label bar, an input-shaped bar and a button-shaped bar, all pulsing. Without this block the
    // section popped in after load.
    const billingEmail = screen.getByTestId('billing-email-skeleton');
    expect(billingEmail).toBeInTheDocument();
    expect(billingEmail).toHaveClass('border-border', 'bg-card', 'rounded-2xl', 'p-6');
    expect(billingEmail.querySelectorAll('.animate-pulse')).toHaveLength(3);

    // Ordering: the billing-email card is LAST, matching `BillingSettingsSections`' render order.
    const cards = container.querySelectorAll('.rounded-2xl.border.p-6');
    expect(cards[cards.length - 1]).toBe(billingEmail);
  });
});
