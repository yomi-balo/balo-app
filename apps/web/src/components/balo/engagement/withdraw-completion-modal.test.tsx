import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

import { WithdrawCompletionModal } from './withdraw-completion-modal';

function setup(overrides: Partial<React.ComponentProps<typeof WithdrawCompletionModal>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <WithdrawCompletionModal
      open
      clientCompanyName="Northwind"
      pending={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { onConfirm, onCancel };
}

describe('WithdrawCompletionModal', () => {
  it('renders the party-named body and both actions', () => {
    setup();
    expect(screen.getByText(/the project goes back to active/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep it under review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Withdraw request/i })).toBeInTheDocument();
  });

  it('calls onConfirm when "Withdraw request" is clicked', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByRole('button', { name: /Withdraw request/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel from "Keep it under review"', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Keep it under review' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while pending', () => {
    setup({ pending: true });
    expect(screen.getByRole('button', { name: 'Keep it under review' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Withdraw request/i })).toBeDisabled();
  });
});
