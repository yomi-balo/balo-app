import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkAvailabilityCard } from './work-availability-card';

const IN_FLIGHT = { upcomingConsultations: 1, activeProjects: 0 };

function setup(overrides: Partial<React.ComponentProps<typeof WorkAvailabilityCard>> = {}): {
  onResume: ReturnType<typeof vi.fn>;
  onPause: ReturnType<typeof vi.fn>;
  onPauseCancelled: ReturnType<typeof vi.fn>;
} {
  const handlers = { onResume: vi.fn(), onPause: vi.fn(), onPauseCancelled: vi.fn() };
  render(
    <WorkAvailabilityCard
      available
      workInFlight={IN_FLIGHT}
      saving={false}
      {...handlers}
      {...overrides}
    />
  );
  return handlers;
}

describe('WorkAvailabilityCard', () => {
  it('available: switch on, available copy, no Paused pill', () => {
    setup();

    expect(screen.getByRole('switch', { name: 'Available for new work' })).toBeChecked();
    expect(
      screen.getByText('Clients can book consultations with you and send you project briefs.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Availability for new work' })).not.toHaveClass(
      'bg-paused-hatch'
    );
  });

  it('paused: switch off, paused copy, Paused pill and the shared hatch', () => {
    setup({ available: false });

    const region = screen.getByRole('region', { name: 'Availability for new work' });
    expect(screen.getByRole('switch', { name: 'Available for new work' })).not.toBeChecked();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(region).toHaveClass('bg-paused-hatch');
    expect(screen.getByRole('switch')).toHaveAccessibleDescription(
      "You're paused. Clients can't book consultations or send you new project briefs. Your current consultations and projects carry on as normal."
    );
  });

  it('turning off opens the dialog and writes nothing; confirming calls onPause', async () => {
    const user = userEvent.setup();
    const { onPause, onResume } = setup();

    await user.click(screen.getByRole('switch'));
    expect(await screen.findByRole('alertdialog', { name: 'Pause new work?' })).toBeVisible();
    expect(onPause).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Pause new work' }));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('dismissing the dialog calls onPauseCancelled and never onPause', async () => {
    const user = userEvent.setup();
    const { onPause, onPauseCancelled } = setup();

    await user.click(screen.getByRole('switch'));
    await user.keyboard('{Escape}');

    expect(onPauseCancelled).toHaveBeenCalledTimes(1);
    expect(onPause).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('turning on needs no dialog', async () => {
    const user = userEvent.setup();
    const { onResume } = setup({ available: false });

    await user.click(screen.getByRole('switch'));

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('the switch is inert while a change is being saved', () => {
    setup({ saving: true });
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});
