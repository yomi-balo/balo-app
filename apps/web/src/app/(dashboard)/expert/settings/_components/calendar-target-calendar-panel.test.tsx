import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CalendarTargetCalendarPanel } from './calendar-target-calendar-panel';
import type { CalendarConnection, SubCalendar } from '../_types/calendar';

const makeSubCalendar = (overrides: Partial<SubCalendar> = {}): SubCalendar => ({
  id: 'cal-1',
  name: 'Primary',
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
  targetCalendarId: 'cal-1',
  subCalendars: [makeSubCalendar()],
  ...overrides,
});

describe('CalendarTargetCalendarPanel', () => {
  it('renders a unique per-provider trigger id, matching the label', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection()}
        provider="google"
        pending={false}
        onChange={vi.fn()}
      />
    );
    const trigger = screen.getByRole('combobox', { name: 'Where bookings go' });
    expect(trigger).toHaveAttribute('id', 'target-calendar-google');
  });

  it('scopes the trigger id to microsoft for a microsoft connection — no duplicate DOM id', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection({ provider: 'microsoft' })}
        provider="microsoft"
        pending={false}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Where bookings go' })).toHaveAttribute(
      'id',
      'target-calendar-microsoft'
    );
  });

  it('shows no stale-target warning when targetCalendarId matches a live sub-calendar', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection()}
        provider="google"
        pending={false}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByText(/no longer on this account/)).not.toBeInTheDocument();
  });

  it('shows the stale-target warning when targetCalendarId points at a removed calendar (edge 10)', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection({ targetCalendarId: 'cal-gone' })}
        provider="google"
        pending={false}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByText(/no longer on this account — pick another/)).toBeInTheDocument();
  });

  it('shows no stale-target warning when targetCalendarId is null (edge 9 — first provision found no primary)', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection({ targetCalendarId: null })}
        provider="google"
        pending={false}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByText(/no longer on this account/)).not.toBeInTheDocument();
  });

  it('disables the trigger while pending', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection()}
        provider="google"
        pending
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Where bookings go' })).toBeDisabled();
  });
});
