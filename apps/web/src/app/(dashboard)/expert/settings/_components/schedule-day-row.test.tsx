import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleDayRow } from './schedule-day-row';
import type { DayState } from '../_lib/schedule-helpers';
import { buildEndOptions } from '../_lib/schedule-helpers';

vi.mock('../_lib/schedule-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/schedule-helpers')>();
  return { ...actual, buildEndOptions: vi.fn(actual.buildEndOptions) };
});

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

  it('renders the crossing badge and links it via aria-describedby on the end select', () => {
    const day: DayState = {
      enabled: true,
      ranges: [{ id: 'r1', start: '21:00', end: '01:00' }],
    };
    render(<ScheduleDayRow dayIndex={0} day={day} {...noop} />);

    expect(screen.getByText('Continues into Tuesday')).toBeInTheDocument();
    const endSelect = screen.getByRole('combobox', { name: 'Monday range 1 end time' });
    expect(endSelect.getAttribute('aria-describedby')).toContain('crossing-badge-r1');
  });

  it('renders no badge and no aria-describedby for a non-crossing range', () => {
    render(<ScheduleDayRow dayIndex={0} day={enabledDay()} {...noop} />);

    expect(screen.queryByText(/Continues into/)).not.toBeInTheDocument();
    const endSelect = screen.getByRole('combobox', { name: 'Monday range 1 end time' });
    expect(endSelect.getAttribute('aria-describedby')).toBeNull();
  });

  it('renders the inline conflict pointer and marks both selects invalid', () => {
    const day: DayState = {
      enabled: true,
      ranges: [{ id: 'r1', start: '22:00', end: '02:00' }],
    };
    render(
      <ScheduleDayRow
        dayIndex={0}
        day={day}
        {...noop}
        conflictMessages={{ r1: 'Overlaps with Tuesday…' }}
      />
    );

    expect(screen.getByText('Overlaps with Tuesday…')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Monday range 1 start time' })).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(screen.getByRole('combobox', { name: 'Monday range 1 end time' })).toHaveAttribute(
      'aria-invalid',
      'true'
    );
  });

  it('renders both rows without throwing when a sibling range already crosses midnight', () => {
    const day: DayState = {
      enabled: true,
      ranges: [
        { id: 'r1', start: '20:00', end: '00:00' },
        { id: 'r2', start: '08:00', end: '12:00' },
      ],
    };
    render(<ScheduleDayRow dayIndex={0} day={day} {...noop} />);

    expect(screen.getByRole('combobox', { name: 'Monday range 1 start time' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Monday range 2 start time' })).toBeInTheDocument();
  });

  it('allows a lone non-crossing range to author (next day) end options', () => {
    render(<ScheduleDayRow dayIndex={0} day={enabledDay()} {...noop} />);

    expect(buildEndOptions).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), true);
  });

  it('withholds (next day) end options from the non-crossing sibling of a crossing range', () => {
    const day: DayState = {
      enabled: true,
      ranges: [
        { id: 'r1', start: '20:00', end: '00:00' },
        { id: 'r2', start: '08:00', end: '12:00' },
      ],
    };
    render(<ScheduleDayRow dayIndex={0} day={day} {...noop} />);

    expect(buildEndOptions).toHaveBeenCalledWith(expect.objectContaining({ id: 'r2' }), false);
  });
});
