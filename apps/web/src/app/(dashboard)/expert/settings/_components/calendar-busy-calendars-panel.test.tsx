import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarBusyCalendarsPanel } from './calendar-busy-calendars-panel';
import type { CalendarConnection, SubCalendar } from '../_types/calendar';

const makeSubCalendar = (overrides: Partial<SubCalendar> = {}): SubCalendar => ({
  id: 'cal-1',
  name: 'Work',
  provider: 'google',
  primary: true,
  conflictChecking: true,
  ...overrides,
});

const makeConnection = (overrides: Partial<CalendarConnection> = {}): CalendarConnection => ({
  provider: 'google',
  credentialStatus: 'ACTIVE',
  providerEmail: 'dana@example.com',
  lastSyncedAt: null,
  targetCalendarId: null,
  subCalendars: [makeSubCalendar()],
  ...overrides,
});

describe('CalendarBusyCalendarsPanel', () => {
  it('renders a row per sub-calendar', () => {
    render(
      <CalendarBusyCalendarsPanel
        connection={makeConnection({
          subCalendars: [
            makeSubCalendar({ id: 'a', name: 'Work Calendar', primary: true }),
            makeSubCalendar({ id: 'b', name: 'Team', primary: false }),
          ],
        })}
        pending={false}
        onToggle={vi.fn()}
      />
    );
    expect(screen.getByText('Work Calendar')).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();
  });

  it('calls onToggle when a non-primary row is toggled', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarBusyCalendarsPanel
        connection={makeConnection({
          subCalendars: [
            makeSubCalendar({ id: 'b', name: 'Team', primary: false, conflictChecking: false }),
          ],
        })}
        pending={false}
        onToggle={onToggle}
      />
    );
    await user.click(screen.getByRole('switch', { name: 'Block time from Team' }));
    expect(onToggle).toHaveBeenCalledWith('b', true, 'google');
  });

  // BAL-397 fix round — the toggle's provider comes off the CONNECTION row, never the
  // sub-calendar row. Both columns exist independently, and a disagreement used to make the
  // section's optimistic update silently apply to nothing (pre-flight decision #8).
  it('passes the CONNECTION row provider, even when the sub-calendar row disagrees', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarBusyCalendarsPanel
        connection={makeConnection({
          provider: 'microsoft',
          subCalendars: [
            makeSubCalendar({
              id: 'b',
              name: 'Team',
              provider: 'google',
              primary: false,
              conflictChecking: false,
            }),
          ],
        })}
        pending={false}
        onToggle={onToggle}
      />
    );
    await user.click(screen.getByRole('switch', { name: 'Block time from Team' }));
    expect(onToggle).toHaveBeenCalledWith('b', true, 'microsoft');
  });

  it('renders the invitation empty state (not a hide) when subCalendars is empty', () => {
    render(
      <CalendarBusyCalendarsPanel
        connection={makeConnection({ subCalendars: [] })}
        pending={false}
        onToggle={vi.fn()}
      />
    );
    // CLAUDE.md bans the absence framing — the title leads with the recovery action.
    expect(screen.getByText('Reconnect to find your calendars')).toBeInTheDocument();
    expect(screen.queryByText(/No calendars/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Reconnect and we'll take another look/)).toBeInTheDocument();
  });

  it('disables every row while pending', () => {
    render(
      <CalendarBusyCalendarsPanel
        connection={makeConnection({
          subCalendars: [makeSubCalendar({ id: 'b', name: 'Team', primary: false })],
        })}
        pending
        onToggle={vi.fn()}
      />
    );
    expect(screen.getByRole('switch', { name: 'Block time from Team' })).toBeDisabled();
  });

  // BAL-397 fix round — real inertness for the `reconnect_needed` panels.
  it('disables every row when the panel itself is inert', () => {
    render(
      <CalendarBusyCalendarsPanel
        connection={makeConnection({
          subCalendars: [makeSubCalendar({ id: 'b', name: 'Team', primary: false })],
        })}
        pending={false}
        disabled
        onToggle={vi.fn()}
      />
    );
    expect(screen.getByRole('switch', { name: 'Block time from Team' })).toBeDisabled();
  });
});
