import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarSubCalendarRow } from './calendar-sub-calendar-row';
import type { SubCalendar } from '../_types/calendar';

const makeCalendar = (overrides: Partial<SubCalendar> = {}): SubCalendar => ({
  id: 'cal-1',
  name: 'Work Calendar',
  provider: 'google',
  primary: false,
  conflictChecking: false,
  ...overrides,
});

describe('CalendarSubCalendarRow', () => {
  it('renders the calendar name', () => {
    render(<CalendarSubCalendarRow calendar={makeCalendar()} onToggle={vi.fn()} />);
    expect(screen.getByText('Work Calendar')).toBeInTheDocument();
  });

  it('renders Primary badge for primary calendars', () => {
    render(
      <CalendarSubCalendarRow calendar={makeCalendar({ primary: true })} onToggle={vi.fn()} />
    );
    expect(screen.getByText('Primary')).toBeInTheDocument();
  });

  it('does not render Primary badge for non-primary calendars', () => {
    render(<CalendarSubCalendarRow calendar={makeCalendar()} onToggle={vi.fn()} />);
    expect(screen.queryByText('Primary')).not.toBeInTheDocument();
  });

  it('shows "Always on" text for primary calendars', () => {
    render(
      <CalendarSubCalendarRow calendar={makeCalendar({ primary: true })} onToggle={vi.fn()} />
    );
    expect(screen.getByText('Always on')).toBeInTheDocument();
  });

  it('renders switch with correct aria-label', () => {
    render(<CalendarSubCalendarRow calendar={makeCalendar()} onToggle={vi.fn()} />);
    expect(
      screen.getByRole('switch', { name: 'Use Work Calendar for conflict checking' })
    ).toBeInTheDocument();
  });

  it('switch is disabled for primary calendars', () => {
    render(
      <CalendarSubCalendarRow
        calendar={makeCalendar({ primary: true, conflictChecking: true })}
        onToggle={vi.fn()}
      />
    );
    expect(
      screen.getByRole('switch', { name: 'Use Work Calendar for conflict checking' })
    ).toBeDisabled();
  });

  it('calls onToggle with calendar id and checked state when toggled', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<CalendarSubCalendarRow calendar={makeCalendar()} onToggle={onToggle} />);

    await user.click(
      screen.getByRole('switch', { name: 'Use Work Calendar for conflict checking' })
    );
    expect(onToggle).toHaveBeenCalledWith('cal-1', true);
  });

  it('does not call onToggle when primary calendar switch is clicked', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarSubCalendarRow
        calendar={makeCalendar({ primary: true, conflictChecking: true })}
        onToggle={onToggle}
      />
    );

    await user.click(
      screen.getByRole('switch', { name: 'Use Work Calendar for conflict checking' })
    );
    expect(onToggle).not.toHaveBeenCalled();
  });
});
