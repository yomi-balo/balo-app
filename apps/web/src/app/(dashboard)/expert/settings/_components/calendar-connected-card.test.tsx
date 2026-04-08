import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track } from '@/lib/analytics';
import { CALENDAR_EVENTS } from '@balo/analytics/events';
import type { CalendarConnection, SubCalendar } from '../_types/calendar';

// ── Mocks ───────────────────────────────────────────────────────

const mockDisconnectAction = vi.fn();
vi.mock('../_actions/disconnect-calendar', () => ({
  disconnectCalendarAction: (...args: unknown[]) => mockDisconnectAction(...args),
}));

const mockSetTargetAction = vi.fn();
vi.mock('../_actions/set-target-calendar', () => ({
  setTargetCalendarAction: (...args: unknown[]) => mockSetTargetAction(...args),
}));

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock('motion/react', () => {
  const MOTION_PROPS = new Set([
    'variants',
    'initial',
    'animate',
    'exit',
    'whileHover',
    'whileTap',
    'transition',
  ]);
  const filterMotion = (props: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(props).filter(([k]) => !MOTION_PROPS.has(k)));

  return {
    motion: {
      div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <div {...filterMotion(props)}>{children}</div>
      ),
      span: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        <span {...filterMotion(props)}>{children}</span>
      ),
    },
    AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  };
});

import { CalendarConnectedCard } from './calendar-connected-card';
import { toast } from 'sonner';

// ── Helpers ─────────────────────────────────────────────────────

const makeSubCalendar = (overrides: Partial<SubCalendar> = {}): SubCalendar => ({
  id: 'sub-1',
  name: 'Work Calendar',
  provider: 'google',
  primary: true,
  conflictChecking: true,
  ...overrides,
});

const makeConnection = (overrides: Partial<CalendarConnection> = {}): CalendarConnection => ({
  status: 'connected',
  providerEmail: 'expert@example.com',
  lastSyncedAt: '2026-04-01T10:00:00Z',
  targetCalendarId: null,
  subCalendars: [
    makeSubCalendar(),
    makeSubCalendar({
      id: 'sub-2',
      name: 'Personal',
      primary: false,
      conflictChecking: false,
    }),
  ],
  ...overrides,
});

// ── Tests ───────────────────────────────────────────────────────

describe('CalendarConnectedCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDisconnectAction.mockResolvedValue({
      success: false,
      error: 'Calendar integration is not yet available.',
    });
    mockSetTargetAction.mockResolvedValue({
      success: false,
      error: 'Calendar integration is not yet available.',
    });
  });

  it('renders the provider label', () => {
    render(
      <CalendarConnectedCard
        connection={makeConnection()}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
  });

  it('renders Microsoft 365 label for microsoft provider', () => {
    render(
      <CalendarConnectedCard
        connection={makeConnection()}
        provider="microsoft"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );
    expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
  });

  it('shows the Synced badge when status is connected', () => {
    render(
      <CalendarConnectedCard
        connection={makeConnection()}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );
    expect(screen.getByText('Synced')).toBeInTheDocument();
  });

  it('shows the Syncing badge when status is sync_pending', () => {
    render(
      <CalendarConnectedCard
        connection={makeConnection({ status: 'sync_pending' })}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );
    expect(screen.getByText('Syncing...')).toBeInTheDocument();
  });

  it('shows error state when status is auth_error', () => {
    render(
      <CalendarConnectedCard
        connection={makeConnection({ status: 'auth_error' })}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );
    expect(screen.getByText('Sync error')).toBeInTheDocument();
    expect(screen.getByText('Reconnect')).toBeInTheDocument();
    expect(screen.getByText(/Authorization has expired/)).toBeInTheDocument();
  });

  it('shows provider email when available', () => {
    render(
      <CalendarConnectedCard
        connection={makeConnection()}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );
    expect(screen.getByText('expert@example.com')).toBeInTheDocument();
  });

  it('renders sub-calendars list', () => {
    render(
      <CalendarConnectedCard
        connection={makeConnection()}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );
    expect(screen.getByText('Work Calendar')).toBeInTheDocument();
    expect(screen.getByText('Personal')).toBeInTheDocument();
  });

  it('shows active conflict count badge', () => {
    render(
      <CalendarConnectedCard
        connection={makeConnection()}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );
    expect(screen.getByText('1 blocking conflicts')).toBeInTheDocument();
  });

  it('renders Disconnect button when connected and not confirming', () => {
    render(
      <CalendarConnectedCard
        connection={makeConnection()}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );
    expect(screen.getByText('Disconnect all calendars')).toBeInTheDocument();
  });

  it('shows disconnect confirmation when Disconnect is clicked', async () => {
    const user = userEvent.setup();
    render(
      <CalendarConnectedCard
        connection={makeConnection()}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );

    await user.click(screen.getByText('Disconnect all calendars'));
    expect(screen.getByText('Yes, disconnect')).toBeInTheDocument();
    expect(screen.getByText(/Disconnecting will stop syncing/)).toBeInTheDocument();
  });

  it('calls disconnectCalendarAction, onDisconnect, and tracks event on success', async () => {
    mockDisconnectAction.mockResolvedValueOnce({ success: true });
    const onDisconnect = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarConnectedCard
        connection={makeConnection()}
        provider="google"
        onDisconnect={onDisconnect}
        onToggleConflictCheck={vi.fn()}
      />
    );

    await user.click(screen.getByText('Disconnect all calendars'));
    await user.click(screen.getByText('Yes, disconnect'));

    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.DISCONNECT_INITIATED, {
      provider: 'google',
    });
    expect(mockDisconnectAction).toHaveBeenCalledOnce();
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith('Calendar disconnected.');
  });

  it('shows error toast and does not call onDisconnect when action fails', async () => {
    const onDisconnect = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarConnectedCard
        connection={makeConnection()}
        provider="google"
        onDisconnect={onDisconnect}
        onToggleConflictCheck={vi.fn()}
      />
    );

    await user.click(screen.getByText('Disconnect all calendars'));
    await user.click(screen.getByText('Yes, disconnect'));

    expect(mockDisconnectAction).toHaveBeenCalledOnce();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith('Calendar integration is not yet available.');
  });

  it('hides confirmation when cancel is clicked', async () => {
    const user = userEvent.setup();
    render(
      <CalendarConnectedCard
        connection={makeConnection()}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );

    await user.click(screen.getByText('Disconnect all calendars'));
    expect(screen.getByText('Yes, disconnect')).toBeInTheDocument();

    await user.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Yes, disconnect')).not.toBeInTheDocument();
  });

  it('shows Reconnect button in error state and shows toast on click', async () => {
    const user = userEvent.setup();
    render(
      <CalendarConnectedCard
        connection={makeConnection({ status: 'auth_error' })}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );

    await user.click(screen.getByText('Reconnect'));
    expect(toast.info).toHaveBeenCalledWith('Calendar integration is coming soon.');
  });

  it('renders target calendar selector', () => {
    render(
      <CalendarConnectedCard
        connection={makeConnection()}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );
    expect(screen.getByText('Target calendar')).toBeInTheDocument();
    expect(
      screen.getByText('New consultation events will be created in this calendar.')
    ).toBeInTheDocument();
  });

  it('has accessible label-select association via htmlFor and id', () => {
    render(
      <CalendarConnectedCard
        connection={makeConnection()}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );
    const label = screen.getByText('Target calendar');
    expect(label).toHaveAttribute('for', 'target-calendar-select');
    expect(document.getElementById('target-calendar-select')).toBeInTheDocument();
  });

  it('hides sub-calendars and target selector in error state', () => {
    render(
      <CalendarConnectedCard
        connection={makeConnection({ status: 'auth_error' })}
        provider="google"
        onDisconnect={vi.fn()}
        onToggleConflictCheck={vi.fn()}
      />
    );
    expect(screen.queryByText('Calendars')).not.toBeInTheDocument();
    expect(screen.queryByText('Target calendar')).not.toBeInTheDocument();
  });
});
