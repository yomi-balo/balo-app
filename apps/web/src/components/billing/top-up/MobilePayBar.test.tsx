import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MobilePayBar } from './MobilePayBar';

const PAY = <button type="button">Pay A$1,000.00</button>;

describe('MobilePayBar', () => {
  it('renders the time estimate, the amount and the Pay slot', () => {
    render(<MobilePayBar amountMinor={100_000} promoMinor={0} payAction={PAY} />);
    expect(screen.getByText(/Buys ≈ 5 hr 33 min/)).toBeInTheDocument();
    expect(screen.getByText('A$1,000.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pay A\$1,000/i })).toBeInTheDocument();
  });

  it('folds the promo into the time estimate but NOT into the charged amount', () => {
    render(<MobilePayBar amountMinor={100_000} promoMinor={5_000} payAction={PAY} />);
    expect(screen.getByText(/Buys ≈ 5 hr 50 min/)).toBeInTheDocument();
    // The buyer is charged the top-up, never the promo-inflated credited figure.
    expect(screen.getByText('A$1,000.00')).toBeInTheDocument();
  });

  it('sticks to the bottom without the prototype’s margin-top:auto', () => {
    const { container } = render(
      <MobilePayBar amountMinor={100_000} promoMinor={0} payAction={PAY} />
    );
    const bar = container.firstElementChild;
    expect(bar?.className).toContain('sticky');
    expect(bar?.className).toContain('bottom-0');
    // `mt-auto` only works inside the prototype's fixed-height phone frame; in a real scroll
    // container it fights `sticky bottom-0`.
    expect(bar?.className).not.toContain('mt-auto');
  });

  it('uses tokenised translucency so it is correct in dark mode', () => {
    const { container } = render(
      <MobilePayBar amountMinor={100_000} promoMinor={0} payAction={PAY} />
    );
    const bar = container.firstElementChild;
    expect(bar?.className).toContain('bg-background/95');
    // A literal rgba(255,255,255,…) panel (as drawn) would be a white slab over a dark page.
    expect(container.innerHTML).not.toMatch(/rgba\(255/);
  });
});
