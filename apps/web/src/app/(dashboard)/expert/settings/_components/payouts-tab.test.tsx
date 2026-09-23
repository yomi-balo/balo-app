import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PayoutsTab, type PayoutDetailsSummary } from './payouts-tab';

vi.mock('../_actions/save-payout-details', () => ({ savePayoutDetailsAction: vi.fn() }));

const SAVED: PayoutDetailsSummary = {
  countryCode: 'AU',
  currency: 'AUD',
  transferMethod: 'LOCAL',
  entityType: 'PERSONAL',
  tradingName: null,
  formValues: {},
  verifiedAt: null,
  beneficiaryStatus: null,
};

/** The header row: the shared settings header that holds the h1. */
function headerFor(heading: HTMLElement): Element | null {
  return heading.closest('.items-start');
}

describe('PayoutsTab — header', () => {
  it('uses the shared settings header in the empty/form state', () => {
    render(<PayoutsTab initialPayoutDetails={null} />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Payout Details' });
    const header = headerFor(heading);
    expect(header?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(header).toContainElement(screen.getByText(/Where you want to receive your earnings/));
  });

  it('uses the same shared header in the saved state', () => {
    render(<PayoutsTab initialPayoutDetails={SAVED} />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Payout Details' });
    const header = headerFor(heading);
    expect(header?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(header).toContainElement(
      screen.getByText('Your bank details are saved and will be used for payout disbursements.')
    );
  });
});
