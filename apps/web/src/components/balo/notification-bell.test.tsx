import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationBell } from './notification-bell';

// ── Polyfills ───────────────────────────────────────────────────

// Radix ScrollArea uses ResizeObserver, not available in jsdom
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// ── Mocks ───────────────────────────────────────────────────────

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ── Helpers ─────────────────────────────────────────────────────

function makeApiResponse(notifications: Record<string, unknown>[] = [], unreadCount = 0) {
  return {
    ok: true,
    json: () => Promise.resolve({ notifications, unreadCount }),
  };
}

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notif-1',
    event: 'booking.confirmed',
    title: 'New booking',
    body: 'Alice booked a consultation',
    actionUrl: '/cases/case-1',
    readAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('NotificationBell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Default mock returns empty notifications — overridden per test as needed
    mockFetch.mockResolvedValue(makeApiResponse([], 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('loading state', () => {
    it('shows loading skeleton initially', () => {
      mockFetch.mockReturnValue(new Promise(() => {})); // Never resolves
      render(<NotificationBell />);

      expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows "No notifications" when list is empty', async () => {
      mockFetch.mockResolvedValue(makeApiResponse([], 0));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(<NotificationBell />);

      const button = screen.getByRole('button', { name: 'Notifications' });
      await user.click(button);

      await waitFor(() => {
        expect(screen.getByText('No notifications')).toBeInTheDocument();
      });
    });
  });

  describe('with notifications', () => {
    it('shows unread badge with count', async () => {
      mockFetch.mockResolvedValue(makeApiResponse([makeNotification()], 3));

      render(<NotificationBell />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: '3 unread notifications' })).toBeInTheDocument();
      });

      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('uses singular label for exactly 1 unread notification', async () => {
      mockFetch.mockResolvedValue(makeApiResponse([makeNotification()], 1));

      render(<NotificationBell />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: '1 unread notification' })).toBeInTheDocument();
      });
    });

    it('shows 9+ when count exceeds 9', async () => {
      mockFetch.mockResolvedValue(makeApiResponse([makeNotification()], 15));

      render(<NotificationBell />);

      await waitFor(() => {
        expect(screen.getByText('9+')).toBeInTheDocument();
      });
    });

    it('shows notification title and body in popover', async () => {
      mockFetch.mockResolvedValue(makeApiResponse([makeNotification()], 1));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(<NotificationBell />);

      await waitFor(() => {
        expect(screen.getByText('1')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: '1 unread notification' }));

      await waitFor(() => {
        expect(screen.getByText('New booking')).toBeInTheDocument();
        expect(screen.getByText('Alice booked a consultation')).toBeInTheDocument();
      });
    });

    it('marks notification as read and navigates on click', async () => {
      mockFetch
        .mockResolvedValueOnce(makeApiResponse([makeNotification()], 1)) // initial fetch
        .mockResolvedValueOnce(makeApiResponse([makeNotification()], 1)) // popover open refetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }); // mark as read

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<NotificationBell />);

      await waitFor(() => {
        expect(screen.getByText('1')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: '1 unread notification' }));

      await waitFor(() => {
        expect(screen.getByText('New booking')).toBeInTheDocument();
      });

      await user.click(screen.getByText('New booking'));

      // Should call mark as read API
      expect(mockFetch).toHaveBeenCalledWith('/api/notifications/notif-1/read', {
        method: 'PATCH',
      });

      // Should navigate to actionUrl
      expect(mockPush).toHaveBeenCalledWith('/cases/case-1');
    });

    it('does not navigate when notification has no actionUrl', async () => {
      const notif = makeNotification({ actionUrl: null });
      mockFetch
        .mockResolvedValueOnce(makeApiResponse([notif], 1))
        .mockResolvedValueOnce(makeApiResponse([notif], 1))
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<NotificationBell />);

      await waitFor(() => {
        expect(screen.getByText('1')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: '1 unread notification' }));

      await waitFor(() => {
        expect(screen.getByText('New booking')).toBeInTheDocument();
      });

      await user.click(screen.getByText('New booking'));

      expect(mockPush).not.toHaveBeenCalled();
    });

    it('renders notification without body text', async () => {
      const notif = makeNotification({ body: null });
      mockFetch.mockResolvedValue(makeApiResponse([notif], 1));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(<NotificationBell />);

      await waitFor(() => {
        expect(screen.getByText('1')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: '1 unread notification' }));

      await waitFor(() => {
        expect(screen.getByText('New booking')).toBeInTheDocument();
      });

      // Body text should not be rendered
      expect(screen.queryByText('Alice booked a consultation')).not.toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows retry button when fetch fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      render(<NotificationBell />);

      // Wait for loading to finish and error state to appear
      const button = await screen.findByRole('button', { name: 'Notifications' });

      // Reset mock so popover open refetch also fails
      mockFetch.mockRejectedValue(new Error('Network error'));
      await user.click(button);

      await waitFor(() => {
        expect(screen.getByText('Failed to load notifications')).toBeInTheDocument();
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });
    });
  });

  describe('mark all as read', () => {
    it('calls read-all endpoint and clears badge', async () => {
      mockFetch
        .mockResolvedValueOnce(makeApiResponse([makeNotification()], 2)) // initial fetch
        .mockResolvedValueOnce(makeApiResponse([makeNotification()], 2)) // popover open refetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true, count: 2 }),
        }); // mark all read

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<NotificationBell />);

      await waitFor(() => {
        expect(screen.getByText('2')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: '2 unread notifications' }));

      await waitFor(() => {
        expect(screen.getByText('Mark all read')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Mark all read'));

      expect(mockFetch).toHaveBeenCalledWith('/api/notifications/read-all', {
        method: 'POST',
      });
    });
  });
});
