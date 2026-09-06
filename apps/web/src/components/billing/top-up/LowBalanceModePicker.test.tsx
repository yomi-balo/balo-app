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
    settlesToCardOnFile: true,
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

  it('BAL-535 (ADR-1040 Amendment 6 §D) — states the settlement fact for notify_only when settlement really reaches a card', () => {
    renderPicker({ mode: 'notify_only', cardAvailable: true, settlesToCardOnFile: true });
    expect(
      screen.getByText(/time you use beyond your balance still settles to the card on file/i)
    ).toBeInTheDocument();
  });

  it('BAL-535 — makes no CARD claim for notify_only when there is no card to settle to', () => {
    renderPicker({ mode: 'notify_only', cardAvailable: false, settlesToCardOnFile: false });
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
    renderPicker({ mode: 'notify_only', cardAvailable: false, settlesToCardOnFile: false });
    expect(
      screen.getByText(/Time you use beyond your balance still needs settling/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/pause new sessions until a top-up clears it/i)).toBeInTheDocument();
  });

  it.each([true, false])(
    'BAL-535 (L3) — the notify_only arm never says "overdraft" (settlesToCardOnFile=%s; pinned across six files)',
    (settlesToCardOnFile) => {
      renderPicker({ mode: 'notify_only', cardAvailable: true, settlesToCardOnFile });
      expect(document.body.textContent ?? '').not.toMatch(/overdraft/i);
    }
  );

  /**
   * ⚠⚠ FIX ROUND 2 (F3) — THE NEW ARM. `cardAvailable` does NOT mean "a mandate exists": the
   * composer hard-codes it `true` because a first-time card is captured inline at Pay. Selecting
   * the settlement sentence on it therefore told a buyer with no card, and a buyer whose card
   * carries no live off-session mandate, that their overrun "still settles to the card on file"
   * — false at the moment they read it, and settlement is `isWalletMandateActive`-gated. Wiring
   * the sentence back to `cardAvailable` fails both cases below.
   */
  it('F3 — a card ON FILE with NO live mandate makes no settlement claim', () => {
    renderPicker({ mode: 'notify_only', cardAvailable: true, settlesToCardOnFile: false });
    expect(screen.queryByText(/settles to the card on file/i)).not.toBeInTheDocument();
    expect(screen.getByText(/pause new sessions until a top-up clears it/i)).toBeInTheDocument();
  });

  it('F3 — that arm no longer blames a missing card, because a card may well be on file', () => {
    // The old string named only one of the two ways settlement fails to reach a card.
    renderPicker({ mode: 'notify_only', cardAvailable: true, settlesToCardOnFile: false });
    expect(screen.queryByText(/with no card on file/i)).not.toBeInTheDocument();
  });

  it('F3 — the settlement sentence follows settlesToCardOnFile, never cardAvailable', () => {
    // A synthetic combination (neither host can produce it) whose only job is to pin which prop
    // the sentence reads: re-wiring the arm to `cardAvailable` inverts this assertion.
    renderPicker({ mode: 'notify_only', cardAvailable: false, settlesToCardOnFile: true });
    expect(screen.getByText(/still settles to the card on file/i)).toBeInTheDocument();
  });

  // ⚠ MUTATION PROOF for the `useCallback` dependency array, not a duplicate of the tests above.
  // Those all mount FRESH, and `useCallback` always runs its factory on first mount regardless of
  // its deps — so dropping `settlesToCardOnFile` from the array (the shape of the exact defect
  // this ticket fixed, when the dep was `cardAvailable`) would leave them ALL passing. Only
  // re-rendering the SAME mounted instance across a flip can observe a stale memo, so only this
  // test fails on that regression.
  it('BAL-535 — recomputes the notify_only description when settlesToCardOnFile flips on a mounted instance', () => {
    const props = {
      mode: 'notify_only' as const,
      onModeChange: vi.fn(),
      reloadMinor: 30_000,
      thresholdMinor: 5_000,
      onReloadChange: vi.fn(),
      onThresholdChange: vi.fn(),
      cardAvailable: true,
      settlesToCardOnFile: true,
    };
    const { rerender } = render(<LowBalanceModePicker {...props} />);
    expect(screen.getByText(/still settles to the card on file/i)).toBeInTheDocument();

    rerender(<LowBalanceModePicker {...props} settlesToCardOnFile={false} />);
    expect(screen.queryByText(/still settles to the card on file/i)).not.toBeInTheDocument();

    rerender(<LowBalanceModePicker {...props} settlesToCardOnFile />);
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
