import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PauseWorkDialog, carriesOnLine } from './pause-work-dialog';

describe('carriesOnLine', () => {
  it.each([
    [
      { upcomingConsultations: 2, activeProjects: 1 },
      'Your 2 upcoming consultations and 1 active project carry on as normal, and your calendar keeps syncing.',
    ],
    [
      { upcomingConsultations: 1, activeProjects: 0 },
      'Your 1 upcoming consultation carry on as normal, and your calendar keeps syncing.',
    ],
    [
      { upcomingConsultations: 0, activeProjects: 3 },
      'Your 3 active projects carry on as normal, and your calendar keeps syncing.',
    ],
    [{ upcomingConsultations: 0, activeProjects: 0 }, 'Your calendar connection keeps syncing.'],
  ])('reads %j', (counts, expected) => {
    expect(carriesOnLine(counts)).toBe(expected);
  });
});

function renderDialog(workInFlight = { upcomingConsultations: 2, activeProjects: 1 }): {
  onConfirm: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
} {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <PauseWorkDialog open workInFlight={workInFlight} onConfirm={onConfirm} onCancel={onCancel} />
  );
  return { onConfirm, onCancel };
}

describe('PauseWorkDialog', () => {
  it('is a labelled alert dialog spelling out the impact', () => {
    renderDialog();

    const dialog = screen.getByRole('alertdialog', { name: 'Pause new work?' });
    expect(dialog).toHaveAccessibleDescription("While you're paused:");
    expect(screen.getByText("Clients won't be able to book consultations with you.")).toBeVisible();
    expect(
      screen.getByText(
        "Clients can't send you new project briefs. Your profile offers to match them with someone similar instead."
      )
    ).toBeVisible();
    expect(
      screen.getByText(
        'Your hours and time off are kept, ready for when you turn availability back on.'
      )
    ).toBeVisible();
    expect(
      screen.getByText('You can turn availability back on any time from Schedule.')
    ).toBeVisible();
  });

  it('uses the real counts, and just the sync line when both are zero', () => {
    renderDialog({ upcomingConsultations: 0, activeProjects: 0 });
    expect(screen.getByText('Your calendar connection keeps syncing.')).toBeVisible();
  });

  it('puts initial focus on "Keep me available"', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Keep me available' })).toHaveFocus();
  });

  it('confirms without reporting a cancel', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Pause new work' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('reports a cancel for "Keep me available"', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Keep me available' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('reports a cancel for Escape', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog();

    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
