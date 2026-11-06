import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleTimezoneLine } from './schedule-timezone-line';

describe('ScheduleTimezoneLine', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the zone and shows its live wall-clock time, refreshed each minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T05:04:30Z'));
    render(<ScheduleTimezoneLine timezone="UTC" onChange={vi.fn()} />);

    const line = screen.getByText(/Hours are set in/);
    expect(line).toHaveTextContent('Hours are set in UTC — currently Tue 5:04 AM');

    // The next tick lands on the minute boundary, 30s later.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(line).toHaveTextContent('currently Tue 5:05 AM');

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(line).toHaveTextContent('currently Tue 5:06 AM');
  });

  it('re-labels the line in the new zone when the timezone changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T05:04:00Z'));
    const { rerender } = render(<ScheduleTimezoneLine timezone="UTC" onChange={vi.fn()} />);

    rerender(<ScheduleTimezoneLine timezone="Australia/Melbourne" onChange={vi.fn()} />);
    expect(screen.getByText(/Hours are set in/)).toHaveTextContent(
      'Hours are set in Melbourne (GMT+10) — currently Tue 3:04 PM'
    );
  });

  it('stops ticking once unmounted', () => {
    vi.useFakeTimers();
    const { unmount } = render(<ScheduleTimezoneLine timezone="UTC" onChange={vi.fn()} />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('opens the timezone list from "Change timezone" and reports the pick', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ScheduleTimezoneLine timezone="Australia/Melbourne" onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Change timezone' }));
    const listbox = await screen.findByRole('listbox');
    const [sydney] = within(listbox).getAllByText('Sydney');
    if (!sydney) throw new Error('expected a Sydney option');
    await user.click(sydney);

    expect(onChange).toHaveBeenCalledWith('Australia/Sydney');
  });

  it('disables the change link when asked', () => {
    render(<ScheduleTimezoneLine timezone="UTC" onChange={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: 'Change timezone' })).toBeDisabled();
  });

  describe('device zone note', () => {
    /** Fakes only the zero-argument device probe; formatting calls still reach real `Intl`. */
    function mockDeviceZone(timeZone: string): void {
      const RealDateTimeFormat = Intl.DateTimeFormat;
      vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
        this: unknown,
        ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
      ) {
        if (args.length === 0) {
          return { resolvedOptions: () => ({ timeZone }) } as Intl.DateTimeFormat;
        }
        return new RealDateTimeFormat(...args);
      } as unknown as typeof Intl.DateTimeFormat);
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('says where the device is when it differs from the schedule zone', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-14T05:04:00Z'));
      mockDeviceZone('Europe/London');
      render(<ScheduleTimezoneLine timezone="Australia/Sydney" onChange={vi.fn()} />);

      expect(screen.getByText('Your device is in London (GMT+1).')).toBeInTheDocument();
    });

    it('stays silent when the device zone matches in effect (Melbourne vs Sydney)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-14T05:04:00Z'));
      mockDeviceZone('Australia/Melbourne');
      render(<ScheduleTimezoneLine timezone="Australia/Sydney" onChange={vi.fn()} />);

      expect(screen.queryByText(/Your device is in/)).not.toBeInTheDocument();
    });
  });
});
