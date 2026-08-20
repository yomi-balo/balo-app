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

  it('renders no "View-only" tag — read-only calendars are unrepresentable against the shipped backend', () => {
    render(<CalendarSubCalendarRow calendar={makeCalendar()} onToggle={vi.fn()} />);
    expect(screen.queryByText(/view-only/i)).not.toBeInTheDocument();
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

  it('renders switch with a "Block time from" aria-label on non-primary rows', () => {
    render(<CalendarSubCalendarRow calendar={makeCalendar()} onToggle={vi.fn()} />);
    expect(
      screen.getByRole('switch', { name: 'Block time from Work Calendar' })
    ).toBeInTheDocument();
  });

  it('renders an explicit "can\'t be turned off" aria-label on the primary row (a disabled switch is not focusable)', () => {
    render(
      <CalendarSubCalendarRow calendar={makeCalendar({ primary: true })} onToggle={vi.fn()} />
    );
    expect(
      screen.getByRole('switch', {
        name: "Work Calendar always blocks time and can't be turned off",
      })
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
      screen.getByRole('switch', {
        name: "Work Calendar always blocks time and can't be turned off",
      })
    ).toBeDisabled();
  });

  it('switch is disabled and row is aria-busy while pending', () => {
    const { container } = render(
      <CalendarSubCalendarRow calendar={makeCalendar()} onToggle={vi.fn()} pending />
    );
    expect(screen.getByRole('switch', { name: 'Block time from Work Calendar' })).toBeDisabled();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  // BAL-397 fix round — `disabled` is the panel-level inertness (`reconnect_needed`), distinct
  // from `pending`: nothing is in flight, so the row is NOT aria-busy, but the Switch is
  // genuinely out of the tab order rather than merely dimmed by an ancestor class.
  it('switch is disabled but the row is NOT aria-busy when the panel is inert', () => {
    const { container } = render(
      <CalendarSubCalendarRow calendar={makeCalendar()} onToggle={vi.fn()} disabled />
    );
    expect(screen.getByRole('switch', { name: 'Block time from Work Calendar' })).toBeDisabled();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  // BAL-397 fix round — the row NO LONGER passes a provider. `calendar.provider` is a separate
  // column from `calendar_connections.provider` and the two can disagree; the owning panel
  // supplies the connection's provider instead (pre-flight decision #8).
  it('calls onToggle with the calendar id and checked state only — never a provider', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<CalendarSubCalendarRow calendar={makeCalendar()} onToggle={onToggle} />);

    await user.click(screen.getByRole('switch', { name: 'Block time from Work Calendar' }));
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
      screen.getByRole('switch', {
        name: "Work Calendar always blocks time and can't be turned off",
      })
    );
    expect(onToggle).not.toHaveBeenCalled();
  });
});
