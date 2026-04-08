import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track } from '@/lib/analytics';
import { CALENDAR_EVENTS } from '@balo/analytics/events';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

const mockGetCalendarConnection = vi.fn();
vi.mock('../_actions/get-calendar-connection', () => ({
  getCalendarConnectionAction: (...args: unknown[]) => mockGetCalendarConnection(...args),
}));

const mockInitiateCalendarConnect = vi.fn();
vi.mock('../_actions/initiate-calendar-connect', () => ({
  initiateCalendarConnectAction: (...args: unknown[]) => mockInitiateCalendarConnect(...args),
}));

vi.mock('../_actions/disconnect-calendar', () => ({
  disconnectCalendarAction: vi.fn(),
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
    },
    AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  };
});

import { CalendarTab } from './calendar-tab';

// ── Tests ───────────────────────────────────────────────────────

describe('CalendarTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no connection (null) - resolves to empty state
    mockGetCalendarConnection.mockResolvedValue(null);
    mockInitiateCalendarConnect.mockResolvedValue({
      success: false,
      error: 'Calendar integration is coming soon.',
    });
  });

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
    expect(screen.getByText('Details never shared with clients')).toBeInTheDocument();
    expect(screen.getByText('Syncs every 5 minutes')).toBeInTheDocument();
  });

  it('tracks connect event when Google is clicked', async () => {
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

  it('tracks connect event when Microsoft is clicked', async () => {
    const user = userEvent.setup();
    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Microsoft 365'));

    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_INITIATED, {
      provider: 'microsoft',
    });
  });
});
