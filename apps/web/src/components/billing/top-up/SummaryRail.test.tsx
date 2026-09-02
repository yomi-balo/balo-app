import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SummaryRail } from './SummaryRail';

const PAY = <button type="button">Pay A$1,000.00</button>;

describe('SummaryRail', () => {
  it('composes the hero, the top-up line, the paying-with line and the Pay slot', () => {
    render(
      <SummaryRail
        amountMinor={100_000}
        promoMinor={0}
        promoCode={null}
        fx={null}
        payingWith="New card"
        payAction={PAY}
      />
    );
    expect(screen.getByText(/Your top-up buys/i)).toBeInTheDocument();
    expect(screen.getByText('Top-up')).toBeInTheDocument();
    expect(screen.getByText('Paying with')).toBeInTheDocument();
    expect(screen.getByText('New card')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pay A\$1,000/i })).toBeInTheDocument();
  });

  it('shows the promo lines ONLY when a promo is applied', () => {
    const { rerender } = render(
      <SummaryRail
        amountMinor={100_000}
        promoMinor={0}
        promoCode={null}
        fx={null}
        payingWith="New card"
        payAction={PAY}
      />
    );
    expect(screen.queryByText(/bonus/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Credited to wallet/i)).not.toBeInTheDocument();

    rerender(
      <SummaryRail
        amountMinor={100_000}
        promoMinor={5_000}
        promoCode="WELCOME50"
        fx={null}
        payingWith="New card"
        payAction={PAY}
      />
    );
    expect(screen.getByText('WELCOME50 bonus')).toBeInTheDocument();
    expect(screen.getByText('+A$50.00')).toBeInTheDocument();
    expect(screen.getByText('Credited to wallet')).toBeInTheDocument();
    expect(screen.getByText('A$1,050.00')).toBeInTheDocument();
  });

  it('reads the saved card in the paying-with line', () => {
    render(
      <SummaryRail
        amountMinor={100_000}
        promoMinor={0}
        promoCode={null}
        fx={null}
        payingWith="Visa •••• 4242"
        payAction={PAY}
      />
    );
    expect(screen.getByText('Visa •••• 4242')).toBeInTheDocument();
  });

  it('carries the indicative FX line under the top-up figure', () => {
    render(
      <SummaryRail
        amountMinor={100_000}
        promoMinor={0}
        promoCode={null}
        fx={{ currency: 'USD', audToQuote: 0.642 }}
        payingWith="New card"
        payAction={PAY}
      />
    );
    // The rail carries the estimate the prototype has no concept of.
    expect(screen.getAllByText(/US\$642/).length).toBeGreaterThan(0);
  });

  it('omits the FX line entirely when the rate is missing or stale', () => {
    render(
      <SummaryRail
        amountMinor={100_000}
        promoMinor={0}
        promoCode={null}
        fx={null}
        payingWith="New card"
        payAction={PAY}
      />
    );
    expect(screen.queryByText(/US\$/)).not.toBeInTheDocument();
    expect(screen.getByText(/charged in AUD — your bank sets the final rate/i)).toBeInTheDocument();
  });

  it('folds the promo into the "Buys ≈" time estimate', () => {
    render(
      <SummaryRail
        amountMinor={100_000}
        promoMinor={5_000}
        promoCode="WELCOME50"
        fx={null}
        payingWith="New card"
        payAction={PAY}
      />
    );
    // (100_000 + 5_000) / 300 = 350 min = 5 hr 50 min
    expect(screen.getByText(/Buys ≈ 5 hr 50 min/)).toBeInTheDocument();
  });

  it('carries the invoice/transfer fine print that replaced the "Pay with" control — and it GOES somewhere', () => {
    render(
      <SummaryRail
        amountMinor={100_000}
        promoMinor={0}
        promoCode={null}
        fx={null}
        payingWith="New card"
        payAction={PAY}
      />
    );
    expect(screen.getByText(/Paying by invoice or bank transfer/i)).toBeInTheDocument();
    // "Talk to us" is an imperative — it must be a real target, not dead copy a buyer clicks
    // and gets nothing from.
    const link = screen.getByRole('link', { name: /talk to us/i });
    expect(link.getAttribute('href')).toMatch(/^mailto:support@getbalo\.com/);
  });
});
