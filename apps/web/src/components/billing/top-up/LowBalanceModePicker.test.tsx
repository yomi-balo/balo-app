import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LowBalanceModePicker } from './LowBalanceModePicker';

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
});
