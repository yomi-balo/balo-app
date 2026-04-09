import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CalendarConnection, SubCalendar } from '../_types/calendar';

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

import { CalendarSyncPendingCard } from './calendar-sync-pending-card';

// ── Helpers ─────────────────────────────────────────────────────

const makeSubCalendar = (overrides: Partial<SubCalendar> = {}): SubCalendar => ({
  id: 'cal-1',
  name: 'Work',
  provider: 'google',
  primary: true,
  conflictChecking: true,
  ...overrides,
});

const makeConnection = (overrides: Partial<CalendarConnection> = {}): CalendarConnection => ({
  status: 'sync_pending',
  providerEmail: 'yomi@gmail.com',
  lastSyncedAt: null,
  targetCalendarId: null,
  subCalendars: [makeSubCalendar()],
  ...overrides,
});

// ── Tests ───────────────────────────────────────────────────────

describe('CalendarSyncPendingCard', () => {
  it('renders the amber "Permissions incomplete" badge', () => {
    render(
      <CalendarSyncPendingCard
        connection={makeConnection()}
        provider="google"
        onFixPermissions={vi.fn()}
      />
    );
    expect(screen.getByText('Permissions incomplete')).toBeInTheDocument();
  });

  it('renders provider name for Google', () => {
    render(
      <CalendarSyncPendingCard
        connection={makeConnection()}
        provider="google"
        onFixPermissions={vi.fn()}
      />
    );
    expect(screen.getByText('Google Calendar')).toBeInTheDocument();
  });

  it('renders provider name for Microsoft', () => {
    render(
      <CalendarSyncPendingCard
        connection={makeConnection()}
        provider="microsoft"
        onFixPermissions={vi.fn()}
      />
    );
    expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
  });

  it('renders the warning message', () => {
    render(
      <CalendarSyncPendingCard
        connection={makeConnection()}
        provider="google"
        onFixPermissions={vi.fn()}
      />
    );
    expect(screen.getByText(/We couldn't read your calendar/)).toBeInTheDocument();
  });

  it('renders the "Fix permissions" button', () => {
    render(
      <CalendarSyncPendingCard
        connection={makeConnection()}
        provider="google"
        onFixPermissions={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /Fix permissions/i })).toBeInTheDocument();
  });

  it('calls onFixPermissions when button is clicked', async () => {
    const user = userEvent.setup();
    const mockOnFix = vi.fn();
    render(
      <CalendarSyncPendingCard
        connection={makeConnection()}
        provider="google"
        onFixPermissions={mockOnFix}
      />
    );

    await user.click(screen.getByRole('button', { name: /Fix permissions/i }));
    expect(mockOnFix).toHaveBeenCalledOnce();
  });

  it('toggles the "Why did this happen?" expandable section', async () => {
    const user = userEvent.setup();
    render(
      <CalendarSyncPendingCard
        connection={makeConnection()}
        provider="google"
        onFixPermissions={vi.fn()}
      />
    );

    const toggleBtn = screen.getByRole('button', { name: /Why did this happen/i });
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');

    // Expand
    await user.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText(/your calendar provider shows permission toggles/i)
    ).toBeInTheDocument();

    // Collapse
    await user.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders the self-healing note', () => {
    render(
      <CalendarSyncPendingCard
        connection={makeConnection()}
        provider="google"
        onFixPermissions={vi.fn()}
      />
    );
    expect(screen.getByText(/your calendar will sync automatically/i)).toBeInTheDocument();
  });

  it('shows provider email when available', () => {
    render(
      <CalendarSyncPendingCard
        connection={makeConnection({ providerEmail: 'test@example.com' })}
        provider="google"
        onFixPermissions={vi.fn()}
      />
    );
    expect(screen.getByText('test@example.com')).toBeInTheDocument();
  });
});
