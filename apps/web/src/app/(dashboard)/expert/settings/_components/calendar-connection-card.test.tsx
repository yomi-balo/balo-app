import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarConnectionCard } from './calendar-connection-card';
import type { CalendarConnection, CalendarProvider, SubCalendar } from '../_types/calendar';
import type { CalendarSlotState } from '../_lib/calendar-slot-state';

vi.mock('motion/react', () => ({
  motion: {
    div: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  useReducedMotion: () => true,
}));

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

const handlers = {
  onConnect: vi.fn(),
  onCancelConnect: vi.fn(),
  onReconnect: vi.fn(),
  onFixPermissions: vi.fn(),
  onDisconnect: vi.fn(),
  onToggleBusy: vi.fn(),
  onChangeTarget: vi.fn(),
};

function renderRow(
  slotState: CalendarSlotState,
  connection: CalendarConnection | undefined,
  { pending = false, provider = 'google' }: { pending?: boolean; provider?: CalendarProvider } = {}
): ReturnType<typeof render> {
  return render(
    <CalendarConnectionCard
      provider={provider}
      slotState={slotState}
      connection={connection}
      pending={pending}
      {...handlers}
    />
  );
}

describe('CalendarConnectionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Header ────────────────────────────────────────────────────

  it('titles the row with the provider label and puts the account email on the subline', () => {
    renderRow('connected', makeConnection());
    expect(screen.getByRole('heading', { level: 3, name: 'Google Calendar' })).toBeInTheDocument();
    expect(screen.getByText('dana@example.com')).toBeInTheDocument();
  });

  it('falls back to the provider sublabel when there is no providerEmail yet', () => {
    renderRow('connecting', undefined);
    expect(screen.getByRole('heading', { level: 3, name: 'Google Calendar' })).toBeInTheDocument();
    expect(screen.getByText('Google Workspace or Gmail')).toBeInTheDocument();
  });

  it('adds the last-synced time to the subline of a connected row', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    renderRow('connected', makeConnection({ lastSyncedAt: '2026-09-22T09:00:00Z' }));
    expect(screen.getByText('· Last synced 3h ago', { exact: false })).toBeInTheDocument();
  });

  it.each([
    ['2026-09-22T11:59:40Z', 'Synced just now'],
    ['2026-09-22T11:45:00Z', 'Last synced 15m ago'],
    ['2026-09-19T12:00:00Z', 'Last synced 3d ago'],
  ] as const)('formats a sync at %s as "%s"', (lastSyncedAt, words) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    renderRow('connected', makeConnection({ lastSyncedAt }));
    expect(screen.getByText(words, { exact: false })).toBeInTheDocument();
  });

  // `providerEmail` is persisted on connect/reconnect since BAL-575, but rows connected earlier
  // keep null until they reconnect, and `lastSyncedAt` is never written — so the null fixture
  // still models real data.
  it('never reads as pending or as an offer under a Connected pill when email and sync are unknown', () => {
    renderRow(
      'connected',
      makeConnection({
        providerEmail: null,
        lastSyncedAt: null,
        subCalendars: [makeSubCalendar({ name: 'dana@gmail.com' })],
      })
    );
    const heading = screen.getByRole('heading', { level: 3, name: 'Google Calendar' });
    const subline = heading.nextElementSibling;
    expect(subline).toHaveTextContent(/^dana@gmail\.com$/);
    expect(screen.queryByText(/Reading your calendars/)).not.toBeInTheDocument();
    expect(screen.queryByText('Google Workspace or Gmail')).not.toBeInTheDocument();
  });

  it('names the account after the primary calendar only when that name is an address', () => {
    renderRow(
      'connected',
      makeConnection({
        providerEmail: null,
        subCalendars: [
          makeSubCalendar({ id: 'cal-2', name: 'team@example.com', primary: false }),
          makeSubCalendar({ name: 'Calendar' }),
        ],
      })
    );
    const subline = screen.getByRole('heading', { level: 3 }).nextElementSibling;
    // Neither a non-primary address nor a primary name that is not an address stands in.
    expect(subline).toHaveTextContent(/^Google Workspace or Gmail$/);
  });

  it('prefers the stored email over the primary calendar name', () => {
    renderRow(
      'connected',
      makeConnection({ subCalendars: [makeSubCalendar({ name: 'other@example.com' })] })
    );
    const subline = screen.getByRole('heading', { level: 3 }).nextElementSibling;
    expect(subline).toHaveTextContent(/^dana@example\.com$/);
  });

  it('says it is still reading the calendars while the row is setting up', () => {
    renderRow(
      'setting_up',
      makeConnection({ credentialStatus: 'SYNC_PENDING', providerEmail: null, subCalendars: [] })
    );
    const subline = screen.getByRole('heading', { level: 3 }).nextElementSibling;
    expect(subline).toHaveTextContent(/^Google Workspace or Gmail · Reading your calendars…$/);
  });

  it('keeps the last-synced time on a row that needs reconnecting, once one is known', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    renderRow(
      'reconnect_needed',
      makeConnection({ credentialStatus: 'EXPIRED', lastSyncedAt: '2026-09-19T12:00:00Z' })
    );
    const subline = screen.getByRole('heading', { level: 3 }).nextElementSibling;
    expect(subline).toHaveTextContent(/^dana@example\.com · Last synced 3d ago$/);
  });

  it.each(['reconnect_needed', 'connecting', 'attempt_failed', 'o365_waiting'] as const)(
    'shows no sync fragment for %s without a known sync',
    (slotState) => {
      renderRow(slotState, slotState === 'reconnect_needed' ? makeConnection() : undefined);
      expect(screen.queryByText(/synced|Reading your calendars/i)).not.toBeInTheDocument();
    }
  );

  it('reports no sync for a row still waiting to connect, even with a stale sync time', () => {
    renderRow('connecting', makeConnection({ lastSyncedAt: '2026-09-19T12:00:00Z' }));
    expect(screen.queryByText(/synced/i)).not.toBeInTheDocument();
  });

  it.each([
    ['connected', 'Connected', 'success'],
    ['setting_up', 'Setting up', 'neutral'],
    ['reconnect_needed', 'Reconnect needed', 'warning'],
    ['attempt_failed', "Didn't finish", 'destructive'],
    ['connecting', 'Waiting for you', 'neutral'],
    ['o365_waiting', 'Waiting on IT', 'warning'],
  ] as const)('renders the %s status pill as "%s" in the %s tone', (slotState, words, tone) => {
    renderRow(slotState, slotState === 'connected' ? makeConnection() : undefined);
    expect(screen.getByText(words)).toHaveAttribute('data-tone', tone);
  });

  it.each(['idle', 'o365_guidance'] as const)(
    'renders no status pill and no body for %s',
    (slotState) => {
      const { container } = renderRow(slotState, undefined);
      expect(container.querySelector('[data-tone]')).toBeNull();
      expect(container.querySelector('.pl-10')).toBeNull();
    }
  );

  it('shows the options menu for connected', () => {
    renderRow('connected', makeConnection());
    expect(screen.getByRole('button', { name: 'Options for Google Calendar' })).toBeInTheDocument();
  });

  it('shows the options menu for reconnect_needed', () => {
    renderRow('reconnect_needed', makeConnection({ credentialStatus: 'EXPIRED' }));
    expect(screen.getByRole('button', { name: 'Options for Google Calendar' })).toBeInTheDocument();
  });

  it('shows the options menu for setting_up', () => {
    renderRow('setting_up', makeConnection({ credentialStatus: 'SYNC_PENDING', subCalendars: [] }));
    expect(screen.getByRole('button', { name: 'Options for Google Calendar' })).toBeInTheDocument();
  });

  it.each(['connecting', 'attempt_failed', 'o365_waiting', 'o365_guidance'] as const)(
    'hides the options menu for %s — no connection row to act on',
    (slotState) => {
      renderRow(slotState, undefined);
      expect(
        screen.queryByRole('button', { name: 'Options for Google Calendar' })
      ).not.toBeInTheDocument();
    }
  );

  it('disconnects its own provider from the options menu', async () => {
    const user = userEvent.setup();
    renderRow('connected', makeConnection({ provider: 'microsoft' }), { provider: 'microsoft' });
    await user.click(screen.getByRole('button', { name: 'Options for Microsoft Outlook' }));
    await user.click(await screen.findByRole('menuitem', { name: /Disconnect/ }));
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(handlers.onDisconnect).toHaveBeenCalledWith('microsoft');
  });

  // ── Connected: panels always visible ──────────────────────────

  it('shows the busy calendars and booking target of a connected row without any interaction', () => {
    renderRow(
      'connected',
      makeConnection({
        subCalendars: [
          makeSubCalendar(),
          makeSubCalendar({ id: 'cal-2', name: 'Team', primary: false }),
        ],
      })
    );
    expect(screen.getByRole('group', { name: 'Busy calendars' })).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Block time from Team' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Where bookings go' })).toBeVisible();
    // Nothing collapsible stands between the expert and the controls.
    expect(screen.queryByRole('button', { expanded: false, name: /calendars/i })).toBeNull();
  });

  it('leaves the panels operable under connected', () => {
    renderRow(
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

  it('reports a busy toggle with the connection provider', async () => {
    const user = userEvent.setup();
    renderRow(
      'connected',
      makeConnection({
        subCalendars: [
          makeSubCalendar({ id: 'cal-2', name: 'Team', primary: false, conflictChecking: false }),
        ],
      })
    );
    await user.click(screen.getByRole('switch', { name: 'Block time from Team' }));
    expect(handlers.onToggleBusy).toHaveBeenCalledWith('cal-2', true, 'google');
  });

  it('disables the panels while a mutation is pending', () => {
    renderRow(
      'connected',
      makeConnection({
        subCalendars: [
          makeSubCalendar(),
          makeSubCalendar({ id: 'cal-2', name: 'Team', primary: false }),
        ],
      }),
      { pending: true }
    );
    expect(screen.getByRole('switch', { name: 'Block time from Team' })).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  /**
   * BAL-397 — an ACCESSIBILITY defect, not a cosmetic one. An
   * earlier version of this test asserted `pointer-events-none` on the wrapper, which is
   * exactly why the bug survived review: `pointer-events-none` blocks the mouse and nothing
   * else, and `aria-disabled` on an ancestor `<div>` disables no descendant. A keyboard-only
   * expert could tab into a visibly-dimmed row, flip the Switch, and fire a mutation against a
   * connection whose credentials are EXPIRED. Assert the PRIMITIVES are disabled, not that a
   * class is present.
   */
  it('makes the panels genuinely inert (not merely dimmed) under reconnect_needed, while still showing them', () => {
    renderRow(
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

  it('renders a connected row with no connection record as its header alone', () => {
    const { container } = renderRow('connected', undefined);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText('Busy calendars')).not.toBeInTheDocument();
    expect(container.querySelector('.pl-10')).toBeNull();
  });

  it('renders only the reconnect notice under reconnect_needed when there is no connection row', () => {
    renderRow('reconnect_needed', undefined);
    expect(screen.getByText(/lost access to this calendar/)).toBeInTheDocument();
    expect(screen.queryByText('Busy calendars')).not.toBeInTheDocument();
  });

  // ── Other states' bodies ──────────────────────────────────────

  it('renders the reconnect notice for reconnect_needed, reconnecting its own provider', async () => {
    const user = userEvent.setup();
    renderRow('reconnect_needed', makeConnection({ credentialStatus: 'EXPIRED' }));
    expect(screen.getByText(/lost access to this calendar/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(handlers.onReconnect).toHaveBeenCalledWith('google');
  });

  it('renders the connecting body, wiring Re-open window and Cancel to its provider', async () => {
    const user = userEvent.setup();
    renderRow('connecting', undefined);
    expect(screen.getByText(/a Google Calendar sign-in window should have opened/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Re-open window/ }));
    expect(handlers.onConnect).toHaveBeenCalledWith('google');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.onCancelConnect).toHaveBeenCalledWith('google');
  });

  it('renders the attempt_failed body, retrying its provider on Try again', async () => {
    const user = userEvent.setup();
    renderRow('attempt_failed', undefined);
    expect(screen.getByText(/didn't finish/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(handlers.onConnect).toHaveBeenCalledWith('google');
  });

  it('renders the sync-pending notice for setting_up, fixing permissions for its provider', async () => {
    const user = userEvent.setup();
    renderRow(
      'setting_up',
      makeConnection({ credentialStatus: 'SYNC_PENDING', subCalendars: [] }),
      {
        provider: 'microsoft',
      }
    );
    expect(screen.getByText("We're still setting up this calendar")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Fix permissions/ }));
    expect(handlers.onFixPermissions).toHaveBeenCalledWith('microsoft');
  });

  it('renders the o365-waiting notice for o365_waiting, wiring retry and Not now', async () => {
    const user = userEvent.setup();
    renderRow('o365_waiting', undefined, { provider: 'microsoft' });
    expect(screen.getByText('Your IT admin needs to take action')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Try connecting again/ }));
    expect(handlers.onConnect).toHaveBeenCalledWith('microsoft');
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(handlers.onCancelConnect).toHaveBeenCalledWith('microsoft');
  });
});
