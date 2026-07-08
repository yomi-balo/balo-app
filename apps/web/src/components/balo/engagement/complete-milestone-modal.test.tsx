import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

import { CompleteMilestoneModal } from './complete-milestone-modal';

function setup(overrides: Record<string, unknown> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <CompleteMilestoneModal
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

describe('CompleteMilestoneModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the milestone title, notify copy, label, hint, and placeholder', () => {
    setup();
    expect(screen.getByText('Mark milestone complete')).toBeInTheDocument();
    expect(screen.getByText('Discovery')).toBeInTheDocument();
    expect(
      screen.getByText(/Northwind Industrial and the Balo team will be notified/)
    ).toBeInTheDocument();
    expect(screen.getByText('What was delivered? (optional)')).toBeInTheDocument();
    expect(screen.getByText(/A link and a line goes a long way/)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Link to the deliverable, a summary of what changed…')
    ).toBeInTheDocument();
  });

  it('caps the note textarea at 4000 chars to match the server limit', () => {
    setup();
    expect(screen.getByRole('textbox')).toHaveAttribute('maxlength', '4000');
  });

  it('calls onConfirm with the typed note when "Mark complete" is clicked', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.type(screen.getByRole('textbox'), 'Shipped the deck.');
    await user.click(screen.getByRole('button', { name: /mark complete/i }));
    expect(onConfirm).toHaveBeenCalledWith('Shipped the deck.');
  });

  it('calls onConfirm with an empty string when no note is entered', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(screen.getByRole('button', { name: /mark complete/i }));
    expect(onConfirm).toHaveBeenCalledWith('');
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
      <CompleteMilestoneModal
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

  it('while pending: hides the close button and shows a spinner', () => {
    render(
      <CompleteMilestoneModal
        open
        milestoneTitle="Discovery"
        clientCompanyName="Northwind Industrial"
        pending
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    // The dialog renders in a portal (outside the render container) → query the document.
    expect(document.querySelector('.animate-spin')).not.toBeNull();
  });
});
