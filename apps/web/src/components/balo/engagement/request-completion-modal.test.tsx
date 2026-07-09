import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

import { RequestCompletionModal } from './request-completion-modal';

function setup(overrides: Partial<React.ComponentProps<typeof RequestCompletionModal>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <RequestCompletionModal
      open
      modalBody="All 2 milestones are delivered. Northwind reviews the whole project…"
      clientCompanyName="Northwind"
      pending={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />
  );
  return { onConfirm, onCancel };
}

describe('RequestCompletionModal', () => {
  it('renders the pre-derived modal body and both actions', () => {
    setup();
    expect(screen.getByText(/All 2 milestones are delivered/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not yet' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Send for Northwind's review/i })
    ).toBeInTheDocument();
  });

  it('calls onConfirm when the gradient CTA is clicked', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByRole('button', { name: /Send for Northwind's review/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel from "Not yet"', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Not yet' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while pending', () => {
    setup({ pending: true });
    expect(screen.getByRole('button', { name: 'Not yet' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Send for Northwind's review/i })).toBeDisabled();
  });
});
