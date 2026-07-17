import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FundingChoice } from './FundingChoice';

describe('FundingChoice', () => {
  it('renders Card as selectable and Invoice as a disabled "Coming soon" option', () => {
    render(<FundingChoice funding="card" onFundingChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /card/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
    expect(screen.getByText(/invoice \/ transfer/i)).toBeInTheDocument();
  });

  it('fires onFundingChange when Card is pressed', async () => {
    const onChange = vi.fn();
    render(<FundingChoice funding="card" onFundingChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /card/i }));
    expect(onChange).toHaveBeenCalledWith('card');
  });
});
