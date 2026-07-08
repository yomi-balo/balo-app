import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { RemoveMilestoneModal } from './remove-milestone-modal';

function renderModal(props: Partial<React.ComponentProps<typeof RemoveMilestoneModal>> = {}): {
  onConfirm: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
} {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <RemoveMilestoneModal
      open
      milestoneTitle="Data migration dry-run"
      isCompleted={false}
      clientCompanyName="Northwind Industrial"
      pending={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />
  );
  return { onConfirm, onCancel };
}

describe('RemoveMilestoneModal', () => {
  it('renders the default (non-completed) copy', () => {
    renderModal({ isCompleted: false });
    expect(screen.getByText(/comes off the delivery plan/i)).toBeInTheDocument();
    expect(screen.queryByText(/is already complete/i)).not.toBeInTheDocument();
  });

  it('escalates to danger copy when the milestone is already completed', () => {
    renderModal({ isCompleted: true });
    expect(screen.getByText(/is already complete/i)).toBeInTheDocument();
    expect(screen.getByText(/erases delivered work/i)).toBeInTheDocument();
  });

  it('wires the destructive confirm and the "Keep it" cancel', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderModal();
    await user.click(screen.getByRole('button', { name: /remove milestone/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /keep it/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons and shows a spinner while pending', () => {
    renderModal({ pending: true });
    expect(screen.getByRole('button', { name: /remove milestone/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /keep it/i })).toBeDisabled();
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { baseElement } = render(
      <RemoveMilestoneModal
        open
        milestoneTitle="Data migration dry-run"
        isCompleted
        clientCompanyName="Northwind Industrial"
        pending={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(await axe(baseElement)).toHaveNoViolations();
  });
});
