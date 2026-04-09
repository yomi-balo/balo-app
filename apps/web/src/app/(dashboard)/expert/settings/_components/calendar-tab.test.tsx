import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track } from '@/lib/analytics';
import { CALENDAR_EVENTS } from '@balo/analytics/events';
import { toast } from 'sonner';
import type { CalendarConnection } from '../_types/calendar';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

const mockGetCalendarConnection = vi.fn();
vi.mock('../_actions/get-calendar-connection', () => ({
  getCalendarConnectionAction: (...args: unknown[]) => mockGetCalendarConnection(...args),
}));

const mockInitiateCalendarConnect = vi.fn();
vi.mock('../_actions/initiate-calendar-connect', () => ({
  initiateCalendarConnectAction: (...args: unknown[]) => mockInitiateCalendarConnect(...args),
}));

const mockDisconnectCalendar = vi.fn();
vi.mock('../_actions/disconnect-calendar', () => ({
  disconnectCalendarAction: (...args: unknown[]) => mockDisconnectCalendar(...args),
}));

vi.mock('../_actions/toggle-conflict-check', () => ({
  toggleConflictCheckAction: vi.fn(),
}));

const mockFixPermissions = vi.fn();
vi.mock('../_actions/fix-calendar-permissions', () => ({
  fixCalendarPermissionsAction: (...args: unknown[]) => mockFixPermissions(...args),
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

import { CalendarTab } from './calendar-tab';

// ── Helpers ─────────────────────────────────────────────────────

const makeConnection = (overrides: Partial<CalendarConnection> = {}): CalendarConnection => ({
  status: 'connected',
  providerEmail: 'yomi@gmail.com',
  lastSyncedAt: '2026-04-09T00:00:00Z',
  targetCalendarId: 'cal-1',
  subCalendars: [
    {
      id: 'cal-1',
      name: 'Work',
      provider: 'google',
      primary: true,
      conflictChecking: true,
    },
  ],
  ...overrides,
});

// ── Tests ───────────────────────────────────────────────────────

describe('CalendarTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    mockGetCalendarConnection.mockResolvedValue(null);
    mockInitiateCalendarConnect.mockResolvedValue({
      success: false,
      error: 'Failed to initiate',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Basic rendering ──────────────────────────────────────────

  it('renders the Calendar heading', async () => {
    render(<CalendarTab />);
    expect(screen.getByText('Calendar')).toBeInTheDocument();
  });

  it('renders the subtitle description', async () => {
    render(<CalendarTab />);
    expect(
      screen.getByText(
        /Connect your calendar so Balo only shows clients times when you're genuinely free/
      )
    ).toBeInTheDocument();
  });

  // ── Empty state ──────────────────────────────────────────────

  it('renders the empty state by default (no connection)', async () => {
    render(<CalendarTab />);
    await waitFor(() => {
      expect(screen.getByText('Connect a calendar')).toBeInTheDocument();
    });
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
  });

  it('renders the trust row in empty state', async () => {
    render(<CalendarTab />);
    await waitFor(() => {
      expect(screen.getByText('We only read your event times')).toBeInTheDocument();
    });
  });

  // ── Connected state ──────────────────────────────────────────

  it('renders connected state when connection exists', async () => {
    mockGetCalendarConnection.mockResolvedValue(makeConnection());
    render(<CalendarTab />);
    await waitFor(() => {
      expect(screen.getByText('Synced')).toBeInTheDocument();
    });
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
  });

  // ── sync_pending state ───────────────────────────────────────

  it('renders sync_pending state when connection has sync_pending status', async () => {
    mockGetCalendarConnection.mockResolvedValue(makeConnection({ status: 'sync_pending' }));
    render(<CalendarTab />);
    await waitFor(() => {
      expect(screen.getByText('Permissions incomplete')).toBeInTheDocument();
    });
    expect(screen.getByText(/We couldn't read your calendar/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fix permissions/i })).toBeInTheDocument();
  });

  // ── Google connect flow ──────────────────────────────────────

  it('tracks connect event and shows connecting state for Google', async () => {
    const user = userEvent.setup();
    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Google Calendar'));

    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_INITIATED, {
      provider: 'google',
    });
  });

  it('shows error toast when Google connect fails', async () => {
    const user = userEvent.setup();
    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Google Calendar'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to initiate');
    });
  });

  // ── O365 guidance flow ───────────────────────────────────────

  it('shows O365 guidance modal when Microsoft is clicked', async () => {
    const user = userEvent.setup();
    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Microsoft 365'));

    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.O365_GUIDANCE_SHOWN, expect.any(Object));
    await waitFor(() => {
      expect(screen.getByText('Connect Microsoft 365')).toBeInTheDocument();
      expect(screen.getByText('Your IT admin may need to approve this once')).toBeInTheDocument();
    });
  });

  it('calls initiateCalendarConnect when O365 Continue is clicked', async () => {
    const user = userEvent.setup();
    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
    });

    // Click Microsoft → shows guidance
    await user.click(screen.getByText('Microsoft 365'));

    await waitFor(() => {
      expect(screen.getByText('Continue to Microsoft 365')).toBeInTheDocument();
    });

    // Click Continue
    await user.click(screen.getByRole('button', { name: /Continue to Microsoft 365/i }));

    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.O365_GUIDANCE_CONTINUED, expect.any(Object));
    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_INITIATED, {
      provider: 'microsoft',
    });
    expect(mockInitiateCalendarConnect).toHaveBeenCalledWith('microsoft');
  });

  it('returns to empty state when O365 Cancel is clicked', async () => {
    const user = userEvent.setup();
    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Microsoft 365'));

    await waitFor(() => {
      expect(screen.getByText('Continue to Microsoft 365')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Cancel/i }));

    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.O365_GUIDANCE_CANCELLED, expect.any(Object));
    await waitFor(() => {
      expect(screen.getByText('Connect a calendar')).toBeInTheDocument();
    });
  });

  // ── OAuth callback params ────────────────────────────────────

  it('shows success toast on calendar_connected=true', async () => {
    mockSearchParams = new URLSearchParams('calendar_connected=true&calendar_status=connected');
    mockGetCalendarConnection.mockResolvedValue(makeConnection());

    render(<CalendarTab />);

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Calendar connected successfully!');
    });
  });

  it('shows warning toast and sync_pending state for sync_pending callback', async () => {
    mockSearchParams = new URLSearchParams('calendar_connected=true&calendar_status=sync_pending');
    mockGetCalendarConnection.mockResolvedValue(makeConnection({ status: 'sync_pending' }));

    render(<CalendarTab />);

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        'Calendar connected but some permissions need fixing.'
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/We couldn't read your calendar/)).toBeInTheDocument();
    });
  });

  it('shows O365 waiting state on o365_admin_approval error', async () => {
    mockSearchParams = new URLSearchParams('calendar_error=o365_admin_approval');

    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Waiting for IT admin approval')).toBeInTheDocument();
    });
  });

  it('shows session expired when state_expired and no existing connection', async () => {
    mockSearchParams = new URLSearchParams('calendar_error=state_expired');
    mockGetCalendarConnection.mockResolvedValue(null);

    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Connection attempt timed out')).toBeInTheDocument();
    });
  });

  it('preserves connected state when state_expired but connection exists', async () => {
    mockSearchParams = new URLSearchParams('calendar_error=state_expired');
    mockGetCalendarConnection.mockResolvedValue(makeConnection());

    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Synced')).toBeInTheDocument();
    });
  });

  it('shows session_expired for generic calendar errors', async () => {
    mockSearchParams = new URLSearchParams('calendar_error=unknown_error');
    mockGetCalendarConnection.mockResolvedValue(null);

    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Connection attempt timed out')).toBeInTheDocument();
    });
  });

  // ── Fix permissions ──────────────────────────────────────────

  it('calls fixCalendarPermissionsAction when Fix permissions is clicked', async () => {
    const user = userEvent.setup();
    mockGetCalendarConnection.mockResolvedValue(makeConnection({ status: 'sync_pending' }));
    mockFixPermissions.mockResolvedValue({ success: false, error: 'Failed' });

    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Fix permissions/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Fix permissions/i }));

    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.FIX_PERMISSIONS_CLICKED, {
      provider: 'google',
    });
    expect(mockFixPermissions).toHaveBeenCalled();
  });

  it('shows error toast when fix permissions fails', async () => {
    const user = userEvent.setup();
    mockGetCalendarConnection.mockResolvedValue(makeConnection({ status: 'sync_pending' }));
    mockFixPermissions.mockResolvedValue({ success: false });

    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Fix permissions/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Fix permissions/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Failed to generate permission fix link. Please try again.'
      );
    });
  });

  // ── Reconnect from auth_error ────────────────────────────────

  it('calls initiateCalendarConnect when Reconnect is clicked in auth_error', async () => {
    const user = userEvent.setup();
    mockGetCalendarConnection.mockResolvedValue(makeConnection({ status: 'auth_error' }));

    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Reconnect')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Reconnect'));

    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.RECONNECT_CLICKED, {
      provider: 'google',
    });
    expect(mockInitiateCalendarConnect).toHaveBeenCalledWith('google');
  });

  // ── Connecting state error handling ───────────────────────────

  it('shows error toast and reverts to empty when connect initiation fails', async () => {
    const user = userEvent.setup();
    mockInitiateCalendarConnect.mockResolvedValue({ success: false, error: 'Something broke' });

    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Google Calendar'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Something broke');
    });
    // Should revert to empty
    await waitFor(() => {
      expect(screen.getByText('Connect a calendar')).toBeInTheDocument();
    });
  });

  // ── Disconnect ───────────────────────────────────────────────

  it('returns to empty state after successful disconnect', async () => {
    const user = userEvent.setup();
    mockGetCalendarConnection.mockResolvedValue(makeConnection());
    mockDisconnectCalendar.mockResolvedValue({ success: true });

    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Synced')).toBeInTheDocument();
    });

    // Click disconnect → confirm
    await user.click(screen.getByText('Disconnect all calendars'));

    await waitFor(() => {
      expect(screen.getByText(/Disconnecting will stop syncing/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Yes, disconnect/i }));

    await waitFor(() => {
      expect(screen.getByText('Connect a calendar')).toBeInTheDocument();
    });
  });

  // ── Bug regression: O365 retry from waiting state ────────────

  it('calls handleO365Continue directly from O365 waiting retry (no guidance loop)', async () => {
    const user = userEvent.setup();
    mockSearchParams = new URLSearchParams('calendar_error=o365_admin_approval');

    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Waiting for IT admin approval')).toBeInTheDocument();
    });

    // Click "Try connecting again" — calls handleO365Continue, skips guidance modal
    await user.click(screen.getByRole('button', { name: /Try connecting again/i }));

    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.O365_GUIDANCE_CONTINUED, expect.any(Object));
    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_INITIATED, {
      provider: 'microsoft',
    });
    expect(mockInitiateCalendarConnect).toHaveBeenCalledWith('microsoft');
  });

  it('shows session_expired for invalid_state errors (not raw toast)', async () => {
    mockSearchParams = new URLSearchParams('calendar_error=invalid_state');
    mockGetCalendarConnection.mockResolvedValue(null);

    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Connection attempt timed out')).toBeInTheDocument();
    });
  });

  it('restores provider from calendar_provider URL param', async () => {
    mockSearchParams = new URLSearchParams(
      'calendar_error=state_expired&calendar_provider=microsoft'
    );
    mockGetCalendarConnection.mockResolvedValue(null);

    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Connection attempt timed out')).toBeInTheDocument();
    });
    // Should show Microsoft branding, not Google
    expect(screen.getByText(/Microsoft 365 sign-in session expired/i)).toBeInTheDocument();
  });

  it('skips guidance modal on retry from session_expired with Microsoft', async () => {
    const user = userEvent.setup();
    mockSearchParams = new URLSearchParams(
      'calendar_error=state_expired&calendar_provider=microsoft'
    );
    mockGetCalendarConnection.mockResolvedValue(null);

    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Connection attempt timed out')).toBeInTheDocument();
    });

    // "Try again" should skip guidance and go directly to connecting
    await user.click(screen.getByRole('button', { name: /Try again/i }));

    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.SESSION_EXPIRED_TRY_AGAIN, {
      provider: 'microsoft',
    });
    // Should proceed to connect without showing guidance modal
    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_INITIATED, {
      provider: 'microsoft',
    });
    expect(mockInitiateCalendarConnect).toHaveBeenCalledWith('microsoft');
  });
});
