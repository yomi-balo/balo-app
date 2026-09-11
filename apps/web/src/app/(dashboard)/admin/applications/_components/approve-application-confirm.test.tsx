import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApproveApplicationConfirm } from './approve-application-confirm';

function renderConfirm(
  overrides: Partial<{
    firstName: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    pending: boolean;
    onConfirm: () => void;
  }> = {}
) {
  return render(
    <ApproveApplicationConfirm
      firstName={overrides.firstName ?? 'Priya'}
      open={overrides.open ?? true}
      onOpenChange={overrides.onOpenChange ?? vi.fn()}
      pending={overrides.pending ?? false}
      onConfirm={overrides.onConfirm ?? vi.fn()}
    />
  );
}

describe('ApproveApplicationConfirm', () => {
  it('names the applicant as a PERSON in the title', () => {
    renderConfirm();
    expect(screen.getByText('Approve Priya as an expert on Balo?')).toBeInTheDocument();
  });

  /**
   * FIX ROUND F9 — LIGHTWEIGHT, not a second decline sheet. MUTATION: add a reason picker or a
   * required note to this dialog → red.
   */
  it('asks one question — no reason picker, no note field, one way forward and one way out', () => {
    renderConfirm();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('group')).toBeNull();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Not yet', 'Approve']);
  });

  it('states the consequences without a gendered pronoun', () => {
    renderConfirm({ firstName: 'Priya' });
    const description = screen.getByText(/moves straight into the expert workspace/i);
    expect(description).toHaveTextContent(/Priya/);
    expect(description.textContent ?? '').not.toMatch(/\b(he|him|his|she|her|hers)\b/i);
  });

  it('does not render when closed', () => {
    renderConfirm({ open: false });
    expect(screen.queryByText('Approve Priya as an expert on Balo?')).toBeNull();
  });

  it('calls onConfirm when the Approve action is clicked', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    renderConfirm({ onConfirm });

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onOpenChange(false) from the cancel action, and never onConfirm', async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    renderConfirm({ onOpenChange, onConfirm });

    await user.click(screen.getByRole('button', { name: 'Not yet' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disables both actions and shows the in-flight label while pending', () => {
    renderConfirm({ pending: true });

    expect(screen.getByText('Approving…')).toBeInTheDocument();
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
    }
  });

  /** Radix owns the focus trap and the alertdialog semantics — verified, not assumed. */
  it('is an alertdialog whose accessible name is its title', () => {
    renderConfirm();
    expect(
      screen.getByRole('alertdialog', { name: /approve priya as an expert on balo/i })
    ).toBeInTheDocument();
  });
});
