import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RemoveCardConfirm } from './remove-card-confirm';
import type { SavedCard } from '@/components/billing/top-up/types';

const CARD: SavedCard = {
  brand: 'visa',
  last4: '4242',
  expMonth: 8,
  expYear: 2028,
  mandateActive: true,
};

describe('RemoveCardConfirm', () => {
  it('notify_only: states no consequence and uses the plain "Remove card" label', () => {
    render(
      <RemoveCardConfirm
        card={CARD}
        mode="notify_only"
        open
        onOpenChange={vi.fn()}
        pending={false}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByText('Remove Visa •••• 4242?')).toBeInTheDocument();
    expect(screen.getByText(/We'll stop keeping this card on file/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep card' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove card' })).toBeInTheDocument();
  });

  it('auto_topup: states the mode-switch consequence in BOTH the description and the confirm button label', () => {
    render(
      <RemoveCardConfirm
        card={CARD}
        mode="auto_topup"
        open
        onOpenChange={vi.fn()}
        pending={false}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByText(/You're on Auto top-up today/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove card & switch to Just notify me' })
    ).toBeInTheDocument();
  });

  it('keep_going: uses the "Keep me going" mode title', () => {
    render(
      <RemoveCardConfirm
        card={CARD}
        mode="keep_going"
        open
        onOpenChange={vi.fn()}
        pending={false}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByText(/You're on Keep me going today/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove card & switch to Just notify me' })
    ).toBeInTheDocument();
  });

  it('shows "Removing…" and disables both buttons while pending', () => {
    render(
      <RemoveCardConfirm
        card={CARD}
        mode="auto_topup"
        open
        onOpenChange={vi.fn()}
        pending
        onConfirm={vi.fn()}
      />
    );

    const confirmButton = screen.getByRole('button', { name: /Removing…/ });
    expect(confirmButton).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep card' })).toBeDisabled();
  });

  it('a settlement_outstanding block hides the destructive action and shows the blocking copy (security MEDIUM)', () => {
    render(
      <RemoveCardConfirm
        card={CARD}
        mode="auto_topup"
        open
        onOpenChange={vi.fn()}
        pending={false}
        onConfirm={vi.fn()}
        blockedReason="There's unsettled consultation time on this card. Reach out and we'll get it squared away, then you can remove it."
      />
    );

    expect(screen.getByText(/unsettled consultation time on this card/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep card' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove card/i })).not.toBeInTheDocument();
  });

  it('reserves the confirm button width while pending — the label is invisible, not removed (design gap)', () => {
    render(
      <RemoveCardConfirm
        card={CARD}
        mode="notify_only"
        open
        onOpenChange={vi.fn()}
        pending
        onConfirm={vi.fn()}
      />
    );

    // The full label stays in the DOM (just visually hidden) so the button never shrinks to fit
    // "Removing…" — it is excluded from the accessible name, not deleted from layout.
    expect(screen.getByText('Remove card', { selector: 'span' })).toHaveClass('invisible');
  });

  it('calls onConfirm when the destructive action is pressed', async () => {
    const onConfirm = vi.fn();
    render(
      <RemoveCardConfirm
        card={CARD}
        mode="notify_only"
        open
        onOpenChange={vi.fn()}
        pending={false}
        onConfirm={onConfirm}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Remove card' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
