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

  it('renders the trash button with an accessible name when onRemove is provided', async () => {
    const onRemove = vi.fn();
    render(<SavedCardRow card={card()} onChange={vi.fn()} onRemove={onRemove} />);
    const button = screen.getByRole('button', { name: 'Remove card' });
    await userEvent.click(button);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('renders no trash button when onRemove is absent (the composer keeps byte-identical rendering)', () => {
    render(<SavedCardRow card={card()} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Remove card' })).not.toBeInTheDocument();
  });
});

// BAL-529 M3 — appended by fix-round-1 F2. `git show origin/main:.../SavedCardRow.test.tsx`
// restored the nine tests above VERBATIM; these two are the only net-new coverage for the
// `changeDisabledReason` prop. Do not fold these into the restored tests above or edit them.
describe('SavedCardRow — BAL-529 M3 changeDisabledReason', () => {
  it('without changeDisabledReason the Change button is enabled and renders no sr-only description', () => {
    render(<SavedCardRow card={card()} onChange={vi.fn()} />);

    const change = screen.getByRole('button', { name: 'Change' });
    expect(change).toBeEnabled();
    expect(change).not.toHaveAccessibleDescription();
  });

  it('with changeDisabledReason the Change button is disabled and describes the reason', () => {
    render(
      <SavedCardRow
        card={card()}
        onChange={vi.fn()}
        changeDisabledReason="Changing your card isn't available right now — please try again later."
      />
    );

    const change = screen.getByRole('button', { name: 'Change' });
    expect(change).toBeDisabled();
    expect(change).toHaveAccessibleDescription(
      "Changing your card isn't available right now — please try again later."
    );
  });
});
