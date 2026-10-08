import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { DiscardChangesDialog } from './discard-changes-dialog';

/**
 * `AlertDialogAction` and `AlertDialogCancel` are both `DialogPrimitive.Close` under the hood, so
 * clicking either fires `onOpenChange(false)` in addition to its own `onClick`. These tests pin
 * that a click calls EXACTLY the one callback for the button clicked — never both.
 */
describe('DiscardChangesDialog', () => {
  it('pluralises the title and names the applicant in the body', () => {
    render(
      <DiscardChangesDialog open count={3} firstName="Priya" onKeep={vi.fn()} onDiscard={vi.fn()} />
    );
    expect(screen.getByText('Discard 3 changes?')).toBeInTheDocument();
    expect(screen.getByText(/Priya’s application won’t be saved/)).toBeInTheDocument();
  });

  it('uses the singular for one change', () => {
    render(
      <DiscardChangesDialog open count={1} firstName="Priya" onKeep={vi.fn()} onDiscard={vi.fn()} />
    );
    expect(screen.getByText('Discard 1 change?')).toBeInTheDocument();
  });

  it('calls only onDiscard when "Discard changes" is clicked', async () => {
    const user = userEvent.setup();
    const onKeep = vi.fn();
    const onDiscard = vi.fn();
    render(
      <DiscardChangesDialog
        open
        count={2}
        firstName="Priya"
        onKeep={onKeep}
        onDiscard={onDiscard}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
  });

  it('calls only onKeep when "Keep editing" is clicked', async () => {
    const user = userEvent.setup();
    const onKeep = vi.fn();
    const onDiscard = vi.fn();
    render(
      <DiscardChangesDialog
        open
        count={2}
        firstName="Priya"
        onKeep={onKeep}
        onDiscard={onDiscard}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('calls only onKeep on Escape', async () => {
    const user = userEvent.setup();
    const onKeep = vi.fn();
    const onDiscard = vi.fn();
    render(
      <DiscardChangesDialog
        open
        count={2}
        firstName="Priya"
        onKeep={onKeep}
        onDiscard={onDiscard}
      />
    );
    await user.keyboard('{Escape}');
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
  });
});
