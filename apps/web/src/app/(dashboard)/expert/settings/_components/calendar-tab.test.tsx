import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track } from '@/lib/analytics';
import { CALENDAR_EVENTS } from '@balo/analytics/events';

// ── Mocks ───────────────────────────────────────────────────────

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
    },
    AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  };
});

import { CalendarTab } from './calendar-tab';
import { toast } from 'sonner';

// ── Tests ───────────────────────────────────────────────────────

describe('CalendarTab', () => {
  it('renders the Calendar heading', () => {
    render(<CalendarTab />);
    expect(screen.getByText('Calendar')).toBeInTheDocument();
  });

  it('renders the subtitle description', () => {
    render(<CalendarTab />);
    expect(
      screen.getByText(
        /Connect your calendar so Balo only shows clients times when you're genuinely free/
      )
    ).toBeInTheDocument();
  });

  it('renders the empty state by default (no connection)', () => {
    render(<CalendarTab />);
    expect(screen.getByText('Connect a calendar')).toBeInTheDocument();
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
  });

  it('renders the trust row in empty state', () => {
    render(<CalendarTab />);
    expect(screen.getByText('We only read your event times')).toBeInTheDocument();
    expect(screen.getByText('Details never shared with clients')).toBeInTheDocument();
    expect(screen.getByText('Syncs every 5 minutes')).toBeInTheDocument();
  });

  it('tracks connect event and shows toast when Google is clicked', async () => {
    const user = userEvent.setup();
    render(<CalendarTab />);

    await user.click(screen.getByText('Google Calendar'));

    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_INITIATED, {
      provider: 'google',
    });
    expect(toast.info).toHaveBeenCalledWith('Calendar integration is coming soon.');
  });

  it('tracks connect event and shows toast when Microsoft is clicked', async () => {
    const user = userEvent.setup();
    render(<CalendarTab />);

    await user.click(screen.getByText('Microsoft 365'));

    expect(track).toHaveBeenCalledWith(CALENDAR_EVENTS.CONNECT_INITIATED, {
      provider: 'microsoft',
    });
    expect(toast.info).toHaveBeenCalledWith('Calendar integration is coming soon.');
  });
});
