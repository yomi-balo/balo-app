import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

import { RevertMilestoneModal } from './revert-milestone-modal';

function setup(overrides: Record<string, unknown> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <RevertMilestoneModal
      open
      milestoneTitle="Discovery"
      clientCompanyName="Northwind Industrial"
      pending={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { onConfirm, onCancel };
}

describe('RevertMilestoneModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the title, milestone title, and the "reverts are never silent" copy', () => {
    setup();
    expect(screen.getByText('Move back to in progress')).toBeInTheDocument();
    expect(screen.getByText('Discovery')).toBeInTheDocument();
    expect(
      screen.getByText(
        /goes back to in progress and its completion record is cleared\. Northwind Industrial and the Balo team will be notified — reverts are never silent\./
      )
    ).toBeInTheDocument();
  });

  it('calls onConfirm when "Move back" is clicked', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByRole('button', { name: /move back/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('closes via Escape when not pending → calls onCancel', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('swallows Escape while pending → does not call onCancel', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <RevertMilestoneModal
        open
        milestoneTitle="Discovery"
        clientCompanyName="Northwind Industrial"
        pending
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    );
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('while pending: hides the close button, disables the buttons, shows a spinner', () => {
    render(
      <RevertMilestoneModal
        open
        milestoneTitle="Discovery"
        clientCompanyName="Northwind Industrial"
        pending
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /move back/i })).toBeDisabled();
    // The dialog renders in a portal (outside the render container) → query the document.
    expect(document.querySelector('.animate-spin')).not.toBeNull();
  });
});
