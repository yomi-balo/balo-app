import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleDayRow } from './schedule-day-row';
import type { DayState } from '../_lib/schedule-helpers';

function enabledDay(): DayState {
  return { enabled: true, ranges: [{ id: 'r1', start: '09:00', end: '17:00' }] };
}

const noop = {
  onToggle: vi.fn(),
  onRangeChange: vi.fn(),
  onAddRange: vi.fn(),
  onRemoveRange: vi.fn(),
  onCopyToDays: vi.fn(),
};

describe('ScheduleDayRow', () => {
  it('renders "Unavailable" for a disabled day', () => {
    render(<ScheduleDayRow dayIndex={5} day={{ enabled: false, ranges: [] }} {...noop} />);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  it('toggles the day via the switch', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<ScheduleDayRow dayIndex={0} day={enabledDay()} {...noop} onToggle={onToggle} />);

    await user.click(screen.getByRole('switch', { name: 'Monday availability' }));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('adds and removes ranges', async () => {
    const onAddRange = vi.fn();
    const onRemoveRange = vi.fn();
    const user = userEvent.setup();
    render(
      <ScheduleDayRow
        dayIndex={0}
        day={enabledDay()}
        {...noop}
        onAddRange={onAddRange}
        onRemoveRange={onRemoveRange}
      />
    );

    await user.click(screen.getByRole('button', { name: /Add a time range/ }));
    expect(onAddRange).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /Remove Monday range 1/ }));
    expect(onRemoveRange).toHaveBeenCalledWith('r1');
  });

  it('copies hours to selected days via the popover', async () => {
    const onCopyToDays = vi.fn();
    const user = userEvent.setup();
    render(
      <ScheduleDayRow dayIndex={0} day={enabledDay()} {...noop} onCopyToDays={onCopyToDays} />
    );

    await user.click(screen.getByRole('button', { name: /Copy Monday hours to other days/ }));
    await user.click(await screen.findByText('Tuesday'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onCopyToDays).toHaveBeenCalledWith([1]);
  });
});
