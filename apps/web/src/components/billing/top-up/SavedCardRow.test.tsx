import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SavedCardRow, describeSavedCard } from './SavedCardRow';
import type { SavedCard } from './types';

function card(overrides: Partial<SavedCard> = {}): SavedCard {
  return {
    brand: 'visa',
    last4: '4242',
    expMonth: 8,
    expYear: 2028,
    mandateActive: false,
    ...overrides,
  };
}

describe('describeSavedCard', () => {
  it('formats the one string both the row and the rail line use', () => {
    expect(describeSavedCard(card())).toBe('Visa •••• 4242');
  });

  it('uses the full network name, not the chip abbreviation', () => {
    expect(describeSavedCard(card({ brand: 'mastercard', last4: '5100' }))).toBe(
      'Mastercard •••• 5100'
    );
  });
});

describe('SavedCardRow', () => {
  it('renders the brand, masked number and expiry', () => {
    render(<SavedCardRow card={card()} onChange={vi.fn()} />);
    expect(screen.getByText('Visa •••• 4242')).toBeInTheDocument();
    expect(screen.getByText('Expires 08/28')).toBeInTheDocument();
  });

  it('zero-pads a single-digit expiry month', () => {
    render(<SavedCardRow card={card({ expMonth: 1, expYear: 2031 })} onChange={vi.fn()} />);
    expect(screen.getByText('Expires 01/31')).toBeInTheDocument();
  });

  it('calls onChange when "Change" is pressed', async () => {
    const onChange = vi.fn();
    render(<SavedCardRow card={card()} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /change/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('exposes "Change" as a real button (keyboard reachable, not a bare span)', () => {
    render(<SavedCardRow card={card()} onChange={vi.fn()} />);
    const button = screen.getByRole('button', { name: /change/i });
    expect(button).toHaveAttribute('type', 'button');
    expect(button.className).toContain('focus-visible:ring-2');
  });

  it('never renders a Stripe identifier', () => {
    const { container } = render(<SavedCardRow card={card()} onChange={vi.fn()} />);
    expect(container.innerHTML).not.toMatch(/pm_|cus_|seti_/);
  });
});
