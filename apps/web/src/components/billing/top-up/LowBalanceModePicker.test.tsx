import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CARD_BACKED_LOW_BALANCE_MODES } from '@balo/shared/credit';
import { LowBalanceModePicker, MODE_OPTIONS } from './LowBalanceModePicker';

function renderPicker(overrides: Partial<React.ComponentProps<typeof LowBalanceModePicker>> = {}) {
  const props = {
    mode: 'notify_only' as const,
    onModeChange: vi.fn(),
    reloadMinor: 30_000,
    thresholdMinor: 5_000,
    onReloadChange: vi.fn(),
    onThresholdChange: vi.fn(),
    cardAvailable: true,
    ...overrides,
  };
  render(<LowBalanceModePicker {...props} />);
  return props;
}

describe('LowBalanceModePicker', () => {
  it('renders the three modes as a radiogroup', () => {
    renderPicker();
    expect(
      screen.getByRole('radiogroup', { name: /when your balance runs low/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Auto top-up/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Keep me going/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Just notify me/i })).toBeInTheDocument();
  });

  it('marks the selected mode with aria-checked', () => {
    renderPicker({ mode: 'keep_going' });
    expect(screen.getByRole('radio', { name: /Keep me going/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Just notify me/i })).not.toBeChecked();
  });

  it('enables card-backed modes when a card is available (card funding)', () => {
    renderPicker({ cardAvailable: true });
    expect(screen.getByRole('radio', { name: /Auto top-up/i })).not.toBeDisabled();
    expect(screen.queryByText(/add a card to use this/i)).not.toBeInTheDocument();
  });

  it('disables card-backed modes with a warm note when no card is available', () => {
    renderPicker({ cardAvailable: false });
    expect(screen.getByRole('radio', { name: /Auto top-up/i })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Keep me going/i })).toBeDisabled();
    expect(screen.getAllByText(/add a card to use this/i).length).toBeGreaterThan(0);
  });

  it('reveals the Add / When below inputs + mandate disclosure for auto_topup', () => {
    renderPicker({ mode: 'auto_topup' });
    expect(screen.getByLabelText(/^Add$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/When below/i)).toBeInTheDocument();
    expect(screen.getByText(/letting Balo charge this card/i)).toBeInTheDocument();
  });

  it('renders inline field errors when the auto-top-up config is invalid', () => {
    renderPicker({
      mode: 'auto_topup',
      errors: {
        reload: 'Minimum top-up is A$50.',
        threshold: 'Keep the trigger at A$10,000 or below.',
      },
    });
    expect(screen.getByText(/Minimum top-up is A\$50/i)).toBeInTheDocument();
    expect(screen.getByText(/Keep the trigger at A\$10,000 or below/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Add$/i)).toHaveAttribute('aria-invalid', 'true');
  });

  it('fires onModeChange when a mode is selected', async () => {
    const { onModeChange } = renderPicker();
    await userEvent.click(screen.getByRole('radio', { name: /Keep me going/i }));
    expect(onModeChange).toHaveBeenCalledWith('keep_going');
  });

  it('NAMES the card in the consent note when one is on file', () => {
    renderPicker({ mode: 'keep_going', cardLabel: 'Visa •••• 4242' });
    expect(screen.getByText(/letting Balo charge Visa •••• 4242/i)).toBeInTheDocument();
  });

  it('falls back to "this card" when the card has no name yet (about to be entered)', () => {
    renderPicker({ mode: 'keep_going' });
    expect(screen.getByText(/letting Balo charge this card/i)).toBeInTheDocument();
  });

  it('shows the consent note ONLY for a card-backed mode', () => {
    renderPicker({ mode: 'notify_only', cardLabel: 'Visa •••• 4242' });
    expect(screen.queryByText(/letting Balo charge/i)).not.toBeInTheDocument();
  });

  it('BAL-535 (ADR-1040 Amendment 6 §D) — states the settlement fact for notify_only when a card is on file', () => {
    renderPicker({ mode: 'notify_only', cardAvailable: true });
    expect(
      screen.getByText(/time you use beyond your balance still settles to the card on file/i)
    ).toBeInTheDocument();
  });

  it('BAL-535 — makes no CARD claim for notify_only when there is no card to settle to', () => {
    renderPicker({ mode: 'notify_only', cardAvailable: false });
    expect(screen.queryByText(/settles to the card on file/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Tell me when I'm running low — I'll top up myself\./i)
    ).toBeInTheDocument();
  });

  // ⚠ FIX ROUND L3 — the card-less arm is where the consequence is worst (`open()` admits on a
  // funded estimate, a presence session posts every billable minute past zero, settlement finds
  // no mandate) and it used to say NOTHING about it. Reverting to the bare "I'll top up myself."
  // fails here, by name.
  it('BAL-535 (L3) — states the consequence for notify_only with NO card, and offers the way out', () => {
    renderPicker({ mode: 'notify_only', cardAvailable: false });
    expect(
      screen.getByText(/Time you use beyond your balance still needs settling/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/pause new sessions until a top-up clears it/i)).toBeInTheDocument();
  });

  it.each([true, false])(
    'BAL-535 (L3) — the notify_only arm never says "overdraft" (cardAvailable=%s; pinned across six files)',
    (cardAvailable) => {
      renderPicker({ mode: 'notify_only', cardAvailable });
      expect(document.body.textContent ?? '').not.toMatch(/overdraft/i);
    }
  );

  // ⚠ MUTATION PROOF for the `useCallback` dependency array, not a duplicate of the two tests
  // above. Both of those mount FRESH, and `useCallback` always runs its factory on first mount
  // regardless of its deps — so dropping `cardAvailable` from the array again (the exact defect
  // this ticket fixed) would leave them BOTH passing. Only re-rendering the SAME mounted
  // instance across a `cardAvailable` flip can observe a stale memo, so only this test fails on
  // that regression.
  it('BAL-535 — recomputes the notify_only description when cardAvailable flips on a mounted instance', () => {
    const props = {
      mode: 'notify_only' as const,
      onModeChange: vi.fn(),
      reloadMinor: 30_000,
      thresholdMinor: 5_000,
      onReloadChange: vi.fn(),
      onThresholdChange: vi.fn(),
      cardAvailable: true,
    };
    const { rerender } = render(<LowBalanceModePicker {...props} />);
    expect(screen.getByText(/still settles to the card on file/i)).toBeInTheDocument();

    rerender(<LowBalanceModePicker {...props} cardAvailable={false} />);
    expect(screen.queryByText(/still settles to the card on file/i)).not.toBeInTheDocument();

    rerender(<LowBalanceModePicker {...props} cardAvailable />);
    expect(screen.getByText(/still settles to the card on file/i)).toBeInTheDocument();
  });

  it('MODE_OPTIONS.cardBacked agrees with the shared card-backed set (a drift would offer a mode the server refuses)', () => {
    // FIX ROUND (F9) — compared as SORTED sets, not with an order-sensitive `toEqual`: the claim
    // is set-membership ("the same two modes"), and `MODE_OPTIONS` is free to reorder its display
    // list without that being a real drift this test should catch.
    const cardBackedInOptions = MODE_OPTIONS.filter((o) => o.cardBacked).map((o) => o.id);
    expect([...cardBackedInOptions].sort()).toEqual([...CARD_BACKED_LOW_BALANCE_MODES].sort());
  });
});
