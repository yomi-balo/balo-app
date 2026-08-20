import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CalendarConnectionCard } from './calendar-connection-card';
import type { CalendarConnection, SubCalendar } from '../_types/calendar';
import type { CalendarSlotState } from '../_lib/calendar-slot-state';

const makeSubCalendar = (overrides: Partial<SubCalendar> = {}): SubCalendar => ({
  id: 'cal-1',
  name: 'Primary Cal',
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

const NOOP_HANDLERS = {
  onConnect: vi.fn(),
  onCancelConnect: vi.fn(),
  onReconnect: vi.fn(),
  onFixPermissions: vi.fn(),
  onDisconnect: vi.fn(),
  onToggleBusy: vi.fn(),
  onChangeTarget: vi.fn(),
};

function renderCard(
  slotState: CalendarSlotState,
  connection: CalendarConnection | undefined,
  pending = false
) {
  return render(
    <CalendarConnectionCard
      provider="google"
      slotState={slotState}
      connection={connection}
      pending={pending}
      {...NOOP_HANDLERS}
    />
  );
}

describe('CalendarConnectionCard', () => {
  it('renders the provider email when a connection exists', () => {
    renderCard('connected', makeConnection());
    expect(screen.getByText('dana@example.com')).toBeInTheDocument();
  });

  it('falls back to the provider label when there is no providerEmail yet', () => {
    renderCard('connecting', undefined);
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
  });

  it.each([
    ['connected', 'Connected'],
    ['setting_up', 'Setting up'],
    ['reconnect_needed', 'Reconnect needed'],
    ['attempt_failed', "Didn't finish"],
    ['connecting', 'Waiting for you'],
    ['o365_waiting', 'Waiting on IT'],
  ] as const)('renders the %s badge as "%s"', (slotState, words) => {
    renderCard(slotState, slotState === 'connected' ? makeConnection() : undefined);
    expect(screen.getByText(words)).toBeInTheDocument();
  });

  it('shows the options menu for connected', () => {
    renderCard('connected', makeConnection());
    expect(screen.getByRole('button', { name: 'Options for Google Calendar' })).toBeInTheDocument();
  });

  it('shows the options menu for reconnect_needed', () => {
    renderCard('reconnect_needed', makeConnection({ credentialStatus: 'EXPIRED' }));
    expect(screen.getByRole('button', { name: 'Options for Google Calendar' })).toBeInTheDocument();
  });

  it('shows the options menu for setting_up', () => {
    renderCard(
      'setting_up',
      makeConnection({ credentialStatus: 'SYNC_PENDING', subCalendars: [] })
    );
    expect(screen.getByRole('button', { name: 'Options for Google Calendar' })).toBeInTheDocument();
  });

  it.each(['connecting', 'attempt_failed', 'o365_waiting', 'o365_guidance'] as const)(
    'hides the options menu for %s — no connection row to act on',
    (slotState) => {
      renderCard(slotState, undefined);
      expect(
        screen.queryByRole('button', { name: 'Options for Google Calendar' })
      ).not.toBeInTheDocument();
    }
  );

  it('renders the busy-calendars and target-calendar panels for connected', () => {
    renderCard('connected', makeConnection());
    expect(screen.getByText('Busy calendars')).toBeInTheDocument();
    expect(screen.getByText('Where bookings go')).toBeInTheDocument();
  });

  /**
   * BAL-397 fix round (review WARNING — an ACCESSIBILITY defect, not a cosmetic one). The
   * previous version of this test asserted `pointer-events-none` on the wrapper, which is
   * exactly why the bug survived review: `pointer-events-none` blocks the mouse and nothing
   * else, and `aria-disabled` on an ancestor `<div>` disables no descendant. A keyboard-only
   * expert could tab into a visibly-dimmed row, flip the Switch, and fire a mutation against a
   * connection whose credentials are EXPIRED. Assert the PRIMITIVES are disabled, not that a
   * class is present.
   */
  it('makes the panels genuinely inert (not merely dimmed) under reconnect_needed, while still showing them', () => {
    renderCard(
      'reconnect_needed',
      makeConnection({
        credentialStatus: 'EXPIRED',
        subCalendars: [
          makeSubCalendar(),
          makeSubCalendar({ id: 'cal-2', name: 'Team', primary: false }),
        ],
      })
    );

    // Still shown — the expert needs to see what they are about to lose access to.
    expect(screen.getByText('Busy calendars')).toBeInTheDocument();
    expect(screen.getByText('Where bookings go')).toBeInTheDocument();

    // ...and genuinely out of reach, for the mouse AND the keyboard.
    expect(screen.getByRole('switch', { name: 'Block time from Team' })).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('leaves the panels operable under connected', () => {
    renderCard(
      'connected',
      makeConnection({
        subCalendars: [
          makeSubCalendar(),
          makeSubCalendar({ id: 'cal-2', name: 'Team', primary: false }),
        ],
      })
    );
    expect(screen.getByRole('switch', { name: 'Block time from Team' })).not.toBeDisabled();
    expect(screen.getByRole('combobox')).not.toBeDisabled();
  });

  it('renders the reconnect notice for reconnect_needed', () => {
    renderCard('reconnect_needed', makeConnection({ credentialStatus: 'EXPIRED' }));
    expect(screen.getByText(/lost access to this calendar/)).toBeInTheDocument();
  });

  it('renders the connecting body with Re-open window and Cancel', () => {
    renderCard('connecting', undefined);
    expect(screen.getByRole('button', { name: /Re-open window/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('renders the attempt_failed body with Try again', () => {
    renderCard('attempt_failed', undefined);
    expect(screen.getByText(/didn't finish/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('renders the sync-pending notice for setting_up', () => {
    renderCard(
      'setting_up',
      makeConnection({ credentialStatus: 'SYNC_PENDING', subCalendars: [] })
    );
    expect(screen.getByText("We're still setting up this calendar")).toBeInTheDocument();
  });

  it('renders the o365-waiting notice for o365_waiting', () => {
    renderCard('o365_waiting', undefined);
    expect(screen.getByText('Your IT admin needs to take action')).toBeInTheDocument();
  });
});
