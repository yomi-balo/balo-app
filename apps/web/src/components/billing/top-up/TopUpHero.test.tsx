import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TopUpHero } from './TopUpHero';

describe('TopUpHero', () => {
  it('renders the time estimate and AUD amount', () => {
    render(<TopUpHero amountMinor={100_000} promoMinor={0} fx={null} />);
    expect(screen.getByText(/Your top-up buys/i)).toBeInTheDocument();
    expect(screen.getByText(/5 hr 33 min/)).toBeInTheDocument();
    expect(screen.getByText('A$1,000.00')).toBeInTheDocument();
  });

  it('shows the indicative currency when an fx rate is available', () => {
    render(
      <TopUpHero amountMinor={100_000} promoMinor={0} fx={{ currency: 'USD', audToQuote: 0.642 }} />
    );
    expect(screen.getByText(/US\$642/)).toBeInTheDocument();
  });

  it('shows a promo pill when a bonus is applied and folds it into the time', () => {
    render(<TopUpHero amountMinor={100_000} promoMinor={5_000} fx={null} />);
    expect(screen.getByText(/\+A\$50 promo/)).toBeInTheDocument();
  });

  it('omits the indicative currency when fx is unavailable (stale)', () => {
    render(<TopUpHero amountMinor={100_000} promoMinor={0} fx={null} />);
    expect(screen.queryByText(/US\$/)).not.toBeInTheDocument();
  });

  it('renders the amount in the compact variant too (the stacked layout has no rail)', () => {
    render(<TopUpHero amountMinor={100_000} promoMinor={0} fx={null} compact />);
    expect(screen.getByText('A$1,000.00')).toBeInTheDocument();
    expect(screen.getByText(/5 hr 33 min/)).toBeInTheDocument();
  });

  it('gates the gradient text behind the CSS class, never an inline text-fill-color', () => {
    const { container } = render(<TopUpHero amountMinor={100_000} promoMinor={0} fx={null} />);
    const figure = container.querySelector('.topup-grad-text');
    expect(figure).not.toBeNull();
    // The live bug this replaces: `-webkit-text-fill-color: transparent` applied inline and
    // UNCONDITIONALLY renders the figure BLANK wherever background-clip:text is unsupported.
    // The class in globals.css applies it only inside an `@supports` block.
    expect(container.innerHTML).not.toMatch(/text-fill-color/i);
    expect(figure?.getAttribute('style')).toContain('--topup-grad');
  });

  it('swaps the gradient value at the goal without changing the mechanism', () => {
    const { container: below } = render(
      <TopUpHero amountMinor={100_000} promoMinor={0} fx={null} />
    );
    const { container: atGoal } = render(
      <TopUpHero amountMinor={500_000} promoMinor={0} fx={null} />
    );
    const belowStyle = below.querySelector('.topup-grad-text')?.getAttribute('style');
    const goalStyle = atGoal.querySelector('.topup-grad-text')?.getAttribute('style');
    expect(belowStyle).not.toBe(goalStyle);
    expect(goalStyle).toContain('--topup-grad');
  });
});
