import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { AvailabilityMonthCalendar } from './availability-month-calendar';

describe('AvailabilityMonthCalendar', () => {
  // Day KEYS, not instants — both month bounds must be derived in the same (viewer) frame as
  // `daysWithSlots`; `startOfMonth(instant)` reads browser-local getters instead, which diverges
  // from the keys whenever the viewer zone differs from the browser's (the settings preview does
  // exactly that, by design).
  const viewerTodayKey = '2026-06-01';
  const viewerWindowEndKey = '2026-06-15';

  it('renders a dot only on days with slots, and other days are disabled', () => {
    render(
      <AvailabilityMonthCalendar
        selectedDayKey={null}
        onSelectDayKey={vi.fn()}
        daysWithSlots={new Set(['2026-06-05'])}
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
        daysWithSlots={new Set(['2026-06-05'])}
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
        daysWithSlots={new Set()}
        viewerTodayKey={viewerTodayKey}
        viewerWindowEndKey={viewerWindowEndKey}
      />
    );

    // viewerWindowEnd is the same month as viewerNow (June 2026), so the "next month" nav
    // should already be disabled — there is nowhere forward to go.
    const nextButton = screen.getByRole('button', { name: /next month/i });
    expect(nextButton).toHaveAttribute('aria-disabled', 'true');
  });
});
