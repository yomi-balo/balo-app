import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleDayRow } from './schedule-day-row';
import type { DayState } from '../_lib/schedule-helpers';
import { buildEndOptions, MAX_RANGES_PER_DAY } from '../_lib/schedule-helpers';

vi.mock('../_lib/schedule-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/schedule-helpers')>();
  return { ...actual, buildEndOptions: vi.fn(actual.buildEndOptions) };
});

function enabledDay(): DayState {
  return { enabled: true, ranges: [{ id: 'r1', start: '09:00', end: '17:00' }] };
}

function splitDay(): DayState {
  return {
    enabled: true,
    ranges: [
      { id: 'r1', start: '09:00', end: '12:00' },
      { id: 'r2', start: '13:00', end: '17:00' },
    ],
  };
}

const noop = {
  onToggle: vi.fn(),
  onRangeChange: vi.fn(),
  onAddRange: vi.fn(),
  onRemoveRange: vi.fn(),
  onCopyToDays: vi.fn(),
};

describe('ScheduleDayRow', () => {
  it('renders an off day as "Unavailable" with no time, add or copy controls', () => {
    render(<ScheduleDayRow dayIndex={5} day={{ enabled: false, ranges: [] }} {...noop} />);

    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Saturday availability' })).not.toBeChecked();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add range/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy Saturday hours/ })).not.toBeInTheDocument();
    // The day name is muted while the day is off.
    expect(screen.getByText('Sat')).toHaveClass('text-muted-foreground');
  });

  it('renders an open day with its start and end selects and no "Unavailable"', () => {
    render(<ScheduleDayRow dayIndex={0} day={enabledDay()} {...noop} />);

    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Monday range 1 start time' })).toHaveTextContent(
      '9:00 AM'
    );
    expect(screen.getByRole('combobox', { name: 'Monday range 1 end time' })).toHaveTextContent(
      '5:00 PM'
    );
    expect(screen.getByText('Mon')).toHaveClass('text-foreground');
  });

  it('toggles the day via the switch', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<ScheduleDayRow dayIndex={0} day={enabledDay()} {...noop} onToggle={onToggle} />);

    await user.click(screen.getByRole('switch', { name: 'Monday availability' }));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('toggles the day from its name label too', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ScheduleDayRow
        dayIndex={6}
        day={{ enabled: false, ranges: [] }}
        {...noop}
        onToggle={onToggle}
      />
    );

    await user.click(screen.getByText('Sun'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('adds a range from the "Add range" link, named for its day', async () => {
    const onAddRange = vi.fn();
    const user = userEvent.setup();
    render(<ScheduleDayRow dayIndex={0} day={enabledDay()} {...noop} onAddRange={onAddRange} />);

    await user.click(screen.getByRole('button', { name: 'Add range to Monday' }));
    expect(onAddRange).toHaveBeenCalledTimes(1);
  });

  it('hides "Add range" once the day holds the maximum number of ranges', () => {
    const day: DayState = {
      enabled: true,
      ranges: Array.from({ length: MAX_RANGES_PER_DAY }, (_, i) => ({
        id: `r${i}`,
        start: `${String(8 + i * 3).padStart(2, '0')}:00`,
        end: `${String(9 + i * 3).padStart(2, '0')}:00`,
      })),
    };
    render(<ScheduleDayRow dayIndex={0} day={day} {...noop} />);

    expect(screen.queryByRole('button', { name: /Add range/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Remove Monday range/ })).toHaveLength(
      MAX_RANGES_PER_DAY
    );
  });

  it('offers no remove control on a lone range — the day switch turns it off', () => {
    render(<ScheduleDayRow dayIndex={0} day={enabledDay()} {...noop} />);
    expect(screen.queryByRole('button', { name: /Remove Monday range/ })).not.toBeInTheDocument();
  });

  it('stacks extra ranges, each with its own remove control', async () => {
    const onRemoveRange = vi.fn();
    const user = userEvent.setup();
    render(
      <ScheduleDayRow dayIndex={0} day={splitDay()} {...noop} onRemoveRange={onRemoveRange} />
    );

    expect(screen.getByRole('combobox', { name: 'Monday range 2 start time' })).toHaveTextContent(
      '1:00 PM'
    );
    await user.click(screen.getByRole('button', { name: 'Remove Monday range 2' }));
    expect(onRemoveRange).toHaveBeenCalledWith('r2');
    await user.click(screen.getByRole('button', { name: 'Remove Monday range 1' }));
    expect(onRemoveRange).toHaveBeenCalledWith('r1');
  });

  it('copies hours to selected days via the row-end copy menu', async () => {
    const onCopyToDays = vi.fn();
    const user = userEvent.setup();
    render(
      <ScheduleDayRow dayIndex={0} day={enabledDay()} {...noop} onCopyToDays={onCopyToDays} />
    );

    await user.click(screen.getByRole('button', { name: 'Copy Monday hours to other days' }));
    expect(await screen.findByText('Copy Mon to')).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();

    await user.click(screen.getByText('Tuesday'));
    await user.click(screen.getByText('Thursday'));
    await user.click(screen.getByText('Tuesday'));
    await user.click(apply);

    expect(onCopyToDays).toHaveBeenCalledWith([3]);
    expect(screen.queryByText('Copy Mon to')).not.toBeInTheDocument();
  });

  it('discards unapplied copy targets when the menu closes', async () => {
    const onCopyToDays = vi.fn();
    const user = userEvent.setup();
    render(
      <ScheduleDayRow dayIndex={0} day={enabledDay()} {...noop} onCopyToDays={onCopyToDays} />
    );

    const trigger = screen.getByRole('button', { name: 'Copy Monday hours to other days' });
    await user.click(trigger);
    await user.click(await screen.findByText('Friday'));
    await user.keyboard('{Escape}');
    await user.click(trigger);

    expect(await screen.findByRole('checkbox', { name: 'Friday' })).not.toBeChecked();
    expect(onCopyToDays).not.toHaveBeenCalled();
  });

  describe('row-end actions', () => {
    const HIDE_FOR_FINE_POINTER = '[@media(hover:hover)_and_(pointer:fine)]:opacity-0';

    function actionsCluster(dayFull = 'Monday'): HTMLElement {
      const cluster = screen.getByRole('button', {
        name: `Copy ${dayFull} hours to other days`,
      }).parentElement;
      if (!cluster) throw new Error('copy trigger has no parent');
      return cluster;
    }

    it('fade in on row hover or focus for a hover-capable pointer, and stay shown on touch', () => {
      const { container } = render(<ScheduleDayRow dayIndex={0} day={enabledDay()} {...noop} />);

      expect(container.firstElementChild).toHaveClass('group/day');
      const classes = actionsCluster().className.split(' ');
      // Hidden only under the fine-pointer media query — touch screens never match it.
      expect(classes).toContain(HIDE_FOR_FINE_POINTER);
      expect(classes).not.toContain('opacity-0');
      expect(classes).toEqual(
        expect.arrayContaining([
          'group-hover/day:opacity-100',
          'group-focus-within/day:opacity-100',
        ])
      );
      // Opacity only: nothing that would drop the actions from the tab order.
      expect(classes.some((c) => c.endsWith('hidden') || c.startsWith('invisible'))).toBe(false);
    });

    it('never hide on a row with a conflict message', () => {
      const day: DayState = { enabled: true, ranges: [{ id: 'r1', start: '22:00', end: '02:00' }] };
      render(
        <ScheduleDayRow
          dayIndex={0}
          day={day}
          {...noop}
          conflictMessages={{ r1: 'Overlaps with Tuesday…' }}
        />
      );

      expect(actionsCluster().className).not.toContain(HIDE_FOR_FINE_POINTER);
    });

    it('still hide on a row whose ranges are not the ones in conflict', () => {
      render(
        <ScheduleDayRow
          dayIndex={0}
          day={enabledDay()}
          {...noop}
          conflictMessages={{ 'other-day-range': 'Overlaps with Monday…' }}
        />
      );

      expect(actionsCluster().className).toContain(HIDE_FOR_FINE_POINTER);
    });

    it('stay shown while the copy menu is open', async () => {
      const user = userEvent.setup();
      render(<ScheduleDayRow dayIndex={0} day={enabledDay()} {...noop} />);

      await user.click(screen.getByRole('button', { name: 'Copy Monday hours to other days' }));
      expect(await screen.findByText('Copy Mon to')).toBeInTheDocument();

      expect(actionsCluster().className).not.toContain(HIDE_FOR_FINE_POINTER);
    });
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

  it('labels a range ending exactly at midnight as running until midnight', () => {
    const day: DayState = {
      enabled: true,
      ranges: [{ id: 'r1', start: '20:00', end: '00:00' }],
    };
    render(<ScheduleDayRow dayIndex={6} day={day} {...noop} />);

    expect(screen.getByText('Runs until midnight')).toBeInTheDocument();
    expect(screen.queryByText(/Continues into/)).not.toBeInTheDocument();
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

    expect(screen.getByText('Overlaps with Tuesday…').className.split(' ')).toContain(
      'text-destructive-strong'
    );
    const start = screen.getByRole('combobox', { name: 'Monday range 1 start time' });
    const end = screen.getByRole('combobox', { name: 'Monday range 1 end time' });
    expect(start).toHaveAttribute('aria-invalid', 'true');
    expect(end).toHaveAttribute('aria-invalid', 'true');
    // The pointer is announced with both controls; the end select also carries the badge.
    expect(start).toHaveAttribute('aria-describedby', 'range-error-r1');
    expect(end).toHaveAttribute('aria-describedby', 'crossing-badge-r1 range-error-r1');
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

  it('renders nothing for an out-of-range day index', () => {
    const { container } = render(<ScheduleDayRow dayIndex={7} day={enabledDay()} {...noop} />);
    expect(container).toBeEmptyDOMElement();
  });
});
