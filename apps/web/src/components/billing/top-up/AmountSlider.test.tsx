import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AmountSlider } from './AmountSlider';

describe('AmountSlider', () => {
  it('renders the three tiers with time estimates', () => {
    render(<AmountSlider amountMinor={100_000} promoMinor={0} onAmountChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /A\$300/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /A\$1,000/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /A\$5,000/ })).toBeInTheDocument();
  });

  it('fires onAmountChange when a tier is clicked', async () => {
    const onChange = vi.fn();
    render(<AmountSlider amountMinor={100_000} promoMinor={0} onAmountChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /A\$5,000/ }));
    expect(onChange).toHaveBeenCalledWith(500_000);
  });

  it('shows the encouraging caption below the goal', () => {
    render(<AmountSlider amountMinor={100_000} promoMinor={0} onAmountChange={vi.fn()} />);
    expect(screen.getByText(/the more you add, the more expert time/i)).toBeInTheDocument();
  });

  it('shows the congratulatory goal caption at A$5,000', () => {
    render(<AmountSlider amountMinor={500_000} promoMinor={0} onAmountChange={vi.fn()} />);
    expect(screen.getByText(/Nice —/i)).toBeInTheDocument();
  });
});
