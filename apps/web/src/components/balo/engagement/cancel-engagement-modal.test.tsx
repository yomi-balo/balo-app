import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

import { CancelEngagementModal } from './cancel-engagement-modal';

function setup(overrides: Partial<React.ComponentProps<typeof CancelEngagementModal>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <CancelEngagementModal
      open
      pending={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { onConfirm, onCancel };
}

describe('CancelEngagementModal', () => {
  it('renders the danger copy, a reason field, and the confirm disabled until a reason is typed', () => {
    setup();
    expect(screen.getByText(/This ends delivery permanently/)).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel engagement' })).toBeDisabled();
  });

  it('enables and submits the reason on confirm', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.type(screen.getByLabelText('Reason'), 'Client changed direction.');
    const confirm = screen.getByRole('button', { name: 'Cancel engagement' });
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('Client changed direction.');
  });

  it('calls onCancel from "Keep engagement"', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Keep engagement' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps the confirm disabled for a whitespace-only reason', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText('Reason'), '   ');
    expect(screen.getByRole('button', { name: 'Cancel engagement' })).toBeDisabled();
  });
});
