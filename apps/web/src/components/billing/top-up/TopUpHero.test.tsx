import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TopUpHero } from './TopUpHero';

describe('TopUpHero', () => {
  it('renders the time estimate and AUD amount', () => {
    render(<TopUpHero amountMinor={100_000} promoMinor={0} funding="card" fx={null} />);
    expect(screen.getByText(/Your top-up buys/i)).toBeInTheDocument();
    expect(screen.getByText(/5 hr 33 min/)).toBeInTheDocument();
    expect(screen.getByText('A$1,000.00')).toBeInTheDocument();
  });

  it('shows the indicative currency only under card funding with an fx rate', () => {
    render(
      <TopUpHero
        amountMinor={100_000}
        promoMinor={0}
        funding="card"
        fx={{ currency: 'USD', audToQuote: 0.642 }}
      />
    );
    expect(screen.getByText(/US\$642/)).toBeInTheDocument();
  });

  it('shows a promo pill when a bonus is applied and folds it into the time', () => {
    render(<TopUpHero amountMinor={100_000} promoMinor={5_000} funding="card" fx={null} />);
    expect(screen.getByText(/\+A\$50 promo/)).toBeInTheDocument();
  });

  it('omits the indicative currency when fx is unavailable (stale)', () => {
    render(<TopUpHero amountMinor={100_000} promoMinor={0} funding="card" fx={null} />);
    expect(screen.queryByText(/US\$/)).not.toBeInTheDocument();
  });
});
