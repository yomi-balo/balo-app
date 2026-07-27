import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleEmptyState } from './schedule-empty-state';

describe('ScheduleEmptyState', () => {
  it('is invitation-framed, not absence-framed', () => {
    render(<ScheduleEmptyState onUseDefaults={vi.fn()} onSetUp={vi.fn()} />);
    expect(screen.getByText('Set your weekly hours')).toBeInTheDocument();
    expect(screen.queryByText(/no hours yet/i)).not.toBeInTheDocument();
  });

  it('fires the two entry-point callbacks', async () => {
    const onUseDefaults = vi.fn();
    const onSetUp = vi.fn();
    const user = userEvent.setup();
    render(<ScheduleEmptyState onUseDefaults={onUseDefaults} onSetUp={onSetUp} />);

    await user.click(screen.getByRole('button', { name: 'Use these hours' }));
    expect(onUseDefaults).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Set them up myself' }));
    expect(onSetUp).toHaveBeenCalledTimes(1);
  });
});
