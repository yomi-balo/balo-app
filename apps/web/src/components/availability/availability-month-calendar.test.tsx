import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { AvailabilityMonthCalendar } from './availability-month-calendar';

describe('AvailabilityMonthCalendar', () => {
  // Day KEYS, not instants — both month bounds must be derived in the same (viewer) frame as
  // `daysAtLength`; `startOfMonth(instant)` reads browser-local getters instead, which diverges
  // from the keys whenever the viewer zone differs from the browser's (the settings preview does
  // exactly that, by design).
  const viewerTodayKey = '2026-06-01';
  const viewerWindowEndKey = '2026-06-15';

  it('renders a dot only on days with slots, and other days are disabled', () => {
    render(
      <AvailabilityMonthCalendar
        selectedDayKey={null}
        onSelectDayKey={vi.fn()}
        daysAtLength={new Set(['2026-06-05'])}
        daysShorterOnly={new Set()}
        lengthMinutes={60}
        viewerTodayKey={viewerTodayKey}
        viewerWindowEndKey={viewerWindowEndKey}
      />
    );

    const availableDay = screen.getByRole('button', { name: /June 5th, 2026/ });
    expect(availableDay).not.toBeDisabled();

    const unavailableDay = screen.getByRole('button', { name: /June 6th, 2026/ });
    expect(unavailableDay).toBeDisabled();
  });

  it('clicking an available day calls onSelectDayKey with the right day key', async () => {
    const onSelectDayKey = vi.fn();
    const user = userEvent.setup();

    render(
      <AvailabilityMonthCalendar
        selectedDayKey={null}
        onSelectDayKey={onSelectDayKey}
        daysAtLength={new Set(['2026-06-05'])}
        daysShorterOnly={new Set()}
        lengthMinutes={60}
        viewerTodayKey={viewerTodayKey}
        viewerWindowEndKey={viewerWindowEndKey}
      />
    );

    await user.click(screen.getByRole('button', { name: /June 5th, 2026/ }));
    expect(onSelectDayKey).toHaveBeenCalledWith('2026-06-05');
  });

  it('forward navigation stops at endMonth', () => {
    render(
      <AvailabilityMonthCalendar
        selectedDayKey={null}
        onSelectDayKey={vi.fn()}
        daysAtLength={new Set()}
        daysShorterOnly={new Set()}
        lengthMinutes={60}
        viewerTodayKey={viewerTodayKey}
        viewerWindowEndKey={viewerWindowEndKey}
      />
    );

    // viewerWindowEnd is the same month as viewerNow (June 2026), so the "next month" nav
    // should already be disabled — there is nowhere forward to go.
    const nextButton = screen.getByRole('button', { name: /next month/i });
    expect(nextButton).toHaveAttribute('aria-disabled', 'true');
  });

  it('marks a shorter-only day with a ring, keeps it enabled and shows the legend entry', () => {
    render(
      <AvailabilityMonthCalendar
        selectedDayKey={null}
        onSelectDayKey={vi.fn()}
        daysAtLength={new Set(['2026-06-05'])}
        daysShorterOnly={new Set(['2026-06-08'])}
        lengthMinutes={60}
        viewerTodayKey={viewerTodayKey}
        viewerWindowEndKey={viewerWindowEndKey}
      />
    );

    const ringDay = screen.getByRole('button', { name: /June 8th, 2026.*shorter times only/ });
    expect(ringDay).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /June 5th, 2026$/ })).not.toHaveTextContent(
      /shorter/
    );
    expect(screen.getByText('60-minute times')).toBeInTheDocument();
    expect(screen.getByText('Shorter times only')).toBeInTheDocument();
  });

  it('omits the shorter-only legend entry when no day is shorter-only', () => {
    render(
      <AvailabilityMonthCalendar
        selectedDayKey={null}
        onSelectDayKey={vi.fn()}
        daysAtLength={new Set(['2026-06-05'])}
        daysShorterOnly={new Set()}
        lengthMinutes={30}
        viewerTodayKey={viewerTodayKey}
        viewerWindowEndKey={viewerWindowEndKey}
      />
    );

    expect(screen.getByText('30-minute times')).toBeInTheDocument();
    expect(screen.queryByText('Shorter times only')).not.toBeInTheDocument();
  });

  it('moves the visible month to a selected day in another month', () => {
    const { rerender } = render(
      <AvailabilityMonthCalendar
        selectedDayKey="2026-06-05"
        onSelectDayKey={vi.fn()}
        daysAtLength={new Set(['2026-06-05', '2026-07-02'])}
        daysShorterOnly={new Set()}
        lengthMinutes={60}
        viewerTodayKey={viewerTodayKey}
        viewerWindowEndKey="2026-07-10"
      />
    );
    expect(screen.getByText(/June 2026/)).toBeInTheDocument();

    rerender(
      <AvailabilityMonthCalendar
        selectedDayKey="2026-07-02"
        onSelectDayKey={vi.fn()}
        daysAtLength={new Set(['2026-06-05', '2026-07-02'])}
        daysShorterOnly={new Set()}
        lengthMinutes={60}
        viewerTodayKey={viewerTodayKey}
        viewerWindowEndKey="2026-07-10"
      />
    );
    expect(screen.getByText(/July 2026/)).toBeInTheDocument();
  });

  it('fits the month into the 640px dialog column and keeps 44px touch cells', () => {
    const { container } = render(
      <AvailabilityMonthCalendar
        selectedDayKey={null}
        onSelectDayKey={vi.fn()}
        daysAtLength={new Set(['2026-06-05'])}
        daysShorterOnly={new Set(['2026-06-08'])}
        lengthMinutes={60}
        viewerTodayKey={viewerTodayKey}
        viewerWindowEndKey={viewerWindowEndKey}
      />
    );

    const root = container.querySelector('[data-slot="calendar"]');
    expect(root).toHaveClass('p-0', 'md:[--cell-size:--spacing(7)]');
    expect(screen.getByRole('button', { name: /June 5th, 2026/ })).toHaveClass(
      'pointer-coarse:h-11'
    );
  });

  it('draws the dot and the ring at the same 6px size, in cells and in the legend', () => {
    const { container } = render(
      <AvailabilityMonthCalendar
        selectedDayKey={null}
        onSelectDayKey={vi.fn()}
        daysAtLength={new Set(['2026-06-05'])}
        daysShorterOnly={new Set(['2026-06-08'])}
        lengthMinutes={60}
        viewerTodayKey={viewerTodayKey}
        viewerWindowEndKey={viewerWindowEndKey}
      />
    );

    const markers = container.querySelectorAll('span[aria-hidden="true"].rounded-full');
    expect(markers.length).toBeGreaterThanOrEqual(4);
    markers.forEach((marker) => expect(marker).toHaveClass('h-1.5', 'w-1.5'));
  });
});
