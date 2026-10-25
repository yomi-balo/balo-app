import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track, NOTIFICATION_EVENTS } from '@/lib/analytics';
import { NotificationBell } from './notification-bell';

// ── Polyfills ───────────────────────────────────────────────────

// Radix ScrollArea uses ResizeObserver, not available in jsdom
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// ── Mocks ───────────────────────────────────────────────────────

const mockPush = vi.fn();
const nav = vi.hoisted(() => ({ pathname: '/dashboard' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => nav.pathname,
}));

const motionState = vi.hoisted(() => ({ reduced: false }));
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return { ...createMotionStub(), useReducedMotion: () => motionState.reduced };
});

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ── Helpers ─────────────────────────────────────────────────────

interface Feed {
  notifications: Record<string, unknown>[];
  unreadCount: number;
  lastSeenAt: string | null;
  unseenCount: number;
}

let feed: Feed;
let readByPathIds: string[];

function jsonResponse(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) };
}

function installFetch() {
  mockFetch.mockImplementation((input: string, init?: RequestInit) => {
    if (input.startsWith('/api/notifications?')) return Promise.resolve(jsonResponse(feed));
    if (input === '/api/notifications/seen') {
      const { through } = JSON.parse(String(init?.body)) as { through: string };
      return Promise.resolve(jsonResponse({ lastSeenAt: through }));
    }
    if (input === '/api/notifications/read-by-path') {
      return Promise.resolve(jsonResponse({ readIds: readByPathIds }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

function setFeed(overrides: Partial<Feed> = {}) {
  feed = {
    notifications: [],
    unreadCount: 0,
    lastSeenAt: minutesAgo(60),
    unseenCount: 0,
    ...overrides,
  };
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
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

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function callsTo(url: string) {
  return mockFetch.mock.calls.filter(([input]) => input === url);
}

function feedFetches() {
  return mockFetch.mock.calls.filter(
    ([input]) => typeof input === 'string' && input.startsWith('/api/notifications?')
  );
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

function threeUnseen() {
  return [
    makeNotification({ id: 'n1', title: 'Alpha', createdAt: minutesAgo(3) }),
    makeNotification({ id: 'n2', title: 'Bravo', createdAt: minutesAgo(2) }),
    makeNotification({ id: 'n3', title: 'Charlie', createdAt: minutesAgo(1) }),
  ];
}

// ── Tests ───────────────────────────────────────────────────────

describe('NotificationBell', () => {
  const originalTitle = document.title;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    nav.pathname = '/dashboard';
    motionState.reduced = false;
    readByPathIds = [];
    setVisibility('visible');
    document.title = 'Balo';
    setFeed();
    installFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.title = originalTitle;
  });

  function setup() {
    return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  }

  describe('loading and empty states', () => {
    it('shows the skeleton while the first fetch is in flight', async () => {
      mockFetch.mockReturnValue(new Promise(() => {}));
      const user = setup();
      render(<NotificationBell />);

      await user.click(screen.getByRole('button', { name: 'Notifications' }));

      expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
      expect(screen.queryByText('You’re all caught up.')).not.toBeInTheDocument();
    });

    it('shows the caught-up line when there is nothing', async () => {
      const user = setup();
      render(<NotificationBell />);
      await flush(1);

      await user.click(screen.getByRole('button', { name: 'Notifications' }));

      expect(await screen.findByText('You’re all caught up.')).toBeInTheDocument();
      expect(screen.queryByText('No notifications')).not.toBeInTheDocument();
    });
  });

  describe('badge and panel', () => {
    it('shows the unread badge with the count', async () => {
      setFeed({ notifications: [makeNotification()], unreadCount: 3 });
      render(<NotificationBell />);
      await flush(1);

      expect(screen.getByRole('button', { name: '3 unread notifications' })).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('uses the singular label for exactly 1 unread notification', async () => {
      setFeed({ notifications: [makeNotification()], unreadCount: 1 });
      render(<NotificationBell />);
      await flush(1);

      expect(screen.getByRole('button', { name: '1 unread notification' })).toBeInTheDocument();
    });

    it('caps the badge at 9+', async () => {
      setFeed({ notifications: [makeNotification()], unreadCount: 15 });
      render(<NotificationBell />);
      await flush(1);

      expect(screen.getByText('9+')).toBeInTheDocument();
    });

    it('shows title, body and an accessible unread marker in the panel', async () => {
      setFeed({ notifications: [makeNotification()], unreadCount: 1 });
      const user = setup();
      render(<NotificationBell />);
      await flush(1);

      await user.click(screen.getByRole('button', { name: '1 unread notification' }));

      const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
      expect(within(dialog).getByText('New booking')).toBeInTheDocument();
      expect(within(dialog).getByText('Alice booked a consultation')).toBeInTheDocument();
      expect(within(dialog).getByText('New')).toBeInTheDocument();
      expect(within(dialog).getByText('Unread')).toBeInTheDocument();
    });

    it('renders a notification without body text', async () => {
      setFeed({ notifications: [makeNotification({ body: null })], unreadCount: 1 });
      const user = setup();
      render(<NotificationBell />);
      await flush(1);

      await user.click(screen.getByRole('button', { name: '1 unread notification' }));

      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(screen.queryByText('Alice booked a consultation')).not.toBeInTheDocument();
    });

    it('keeps read items under Earlier', async () => {
      setFeed({
        notifications: [
          makeNotification({ id: 'u', title: 'Fresh one', createdAt: minutesAgo(100) }),
          makeNotification({ id: 'r', title: 'Old one', readAt: minutesAgo(30) }),
        ],
        unreadCount: 1,
      });
      const user = setup();
      render(<NotificationBell />);
      await flush(1);

      await user.click(screen.getByRole('button', { name: '1 unread notification' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Earlier')).toBeInTheDocument();
      expect(within(dialog).getByText('Old one')).toBeInTheDocument();
    });
  });

  describe('opening a notification', () => {
    it('marks it read, keeps the row under Earlier, tracks the click and navigates', async () => {
      setFeed({
        notifications: [makeNotification({ createdAt: minutesAgo(100) })],
        unreadCount: 1,
      });
      const user = setup();
      render(<NotificationBell />);
      await flush(1);

      await user.click(screen.getByRole('button', { name: '1 unread notification' }));
      await user.click(await screen.findByText('New booking'));

      expect(mockFetch).toHaveBeenCalledWith('/api/notifications/notif-1/read', {
        method: 'PATCH',
      });
      expect(track).toHaveBeenCalledWith(NOTIFICATION_EVENTS.CLICKED, {
        event: 'booking.confirmed',
        source: 'panel',
      });
      expect(mockPush).toHaveBeenCalledWith('/cases/case-1');
      expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();

      setFeed({
        notifications: [makeNotification({ createdAt: minutesAgo(100), readAt: minutesAgo(0) })],
        unreadCount: 0,
      });
      await user.click(screen.getByRole('button', { name: 'Notifications' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Earlier')).toBeInTheDocument();
      expect(within(dialog).getByText('New booking')).toBeInTheDocument();
    });

    it('does not navigate when the notification has no actionUrl', async () => {
      setFeed({
        notifications: [makeNotification({ actionUrl: null, createdAt: minutesAgo(100) })],
        unreadCount: 1,
      });
      const user = setup();
      render(<NotificationBell />);
      await flush(1);

      await user.click(screen.getByRole('button', { name: '1 unread notification' }));
      await user.click(await screen.findByText('New booking'));

      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  describe('error state', () => {
    it('shows a retry button when the fetch fails and recovers on retry', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      const user = setup();
      render(<NotificationBell />);
      await flush(1);

      await user.click(screen.getByRole('button', { name: 'Notifications' }));
      expect(await screen.findByText('Failed to load notifications')).toBeInTheDocument();

      installFetch();
      await user.click(screen.getByText('Retry'));

      expect(await screen.findByText('You’re all caught up.')).toBeInTheDocument();
    });
  });

  describe('mark all as read', () => {
    it('calls read-all and clears the badge', async () => {
      setFeed({
        notifications: [makeNotification({ createdAt: minutesAgo(100) })],
        unreadCount: 2,
      });
      const user = setup();
      render(<NotificationBell />);
      await flush(1);

      await user.click(screen.getByRole('button', { name: '2 unread notifications' }));
      await user.click(await screen.findByText('Mark all read'));

      expect(mockFetch).toHaveBeenCalledWith('/api/notifications/read-all', { method: 'POST' });
      expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    });
  });

  describe('arrival on load', () => {
    it('shows one collapsed toast for several unseen items, without opening the panel', async () => {
      setFeed({
        notifications: threeUnseen(),
        unreadCount: 3,
        unseenCount: 3,
        lastSeenAt: minutesAgo(60),
      });
      render(<NotificationBell />);
      await flush(1);

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      await flush(700);

      expect(screen.getAllByRole('status')).toHaveLength(1);
      expect(screen.getByRole('status')).toHaveTextContent('3 updates since your last visit');
      expect(screen.getByRole('status')).toHaveTextContent('Charlie, Bravo and 1 more');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(track).toHaveBeenCalledWith(NOTIFICATION_EVENTS.TOAST_SHOWN, {
        count: 3,
        trigger: 'load',
      });

      const seenCall = callsTo('/api/notifications/seen').at(-1);
      expect(JSON.parse(String(seenCall?.[1]?.body))).toEqual({
        through: feed.notifications[2]?.createdAt,
      });
    });

    it('stays silent on reload once the cursor has passed everything', async () => {
      setFeed({
        notifications: threeUnseen(),
        unreadCount: 3,
        unseenCount: 0,
        lastSeenAt: new Date(Date.now()).toISOString(),
      });
      render(<NotificationBell />);
      await flush(1000);

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(track).not.toHaveBeenCalledWith(NOTIFICATION_EVENTS.TOAST_SHOWN, expect.anything());
    });

    it('shows an item toast for the one unseen item and counts every unread in the badge', async () => {
      setFeed({
        notifications: [
          makeNotification({ id: 'new', title: 'Fresh case', createdAt: minutesAgo(1) }),
          makeNotification({ id: 'o1', title: 'Older 1', createdAt: minutesAgo(200) }),
          makeNotification({ id: 'o2', title: 'Older 2', createdAt: minutesAgo(190) }),
        ],
        unreadCount: 3,
        unseenCount: 1,
        lastSeenAt: minutesAgo(60),
      });
      render(<NotificationBell />);
      await flush(701);

      const toast = screen.getByRole('status');
      expect(within(toast).getByText('Fresh case')).toBeInTheDocument();
      expect(within(toast).getByRole('button', { name: 'Open case' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '3 unread notifications' })).toBeInTheDocument();
    });

    it('records the cursor and announces nothing when there is no cursor yet', async () => {
      setFeed({
        notifications: threeUnseen(),
        unreadCount: 3,
        unseenCount: 0,
        lastSeenAt: null,
      });
      render(<NotificationBell />);
      await flush(1500);

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(callsTo('/api/notifications/seen')).toHaveLength(1);
    });
  });

  describe('auto-read on visit', () => {
    it('marks the visited path read and leaves it out of the toast', async () => {
      nav.pathname = '/projects/p1';
      readByPathIds = ['visited'];
      setFeed({
        notifications: [
          makeNotification({
            id: 'visited',
            title: 'Visited',
            actionUrl: '/projects/p1?from=notification',
            createdAt: minutesAgo(2),
          }),
        ],
        unreadCount: 1,
        unseenCount: 1,
      });
      render(<NotificationBell />);
      await flush(1500);

      const [, init] = callsTo('/api/notifications/read-by-path')[0] ?? [];
      expect(JSON.parse(String(init?.body))).toEqual({ path: '/projects/p1' });
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(track).toHaveBeenCalledWith(NOTIFICATION_EVENTS.AUTO_READ, { count: 1 });
      expect(track).not.toHaveBeenCalledWith(NOTIFICATION_EVENTS.TOAST_SHOWN, expect.anything());
      expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    });

    it('does not post when nothing matches the path', async () => {
      setFeed({
        notifications: [makeNotification({ createdAt: minutesAgo(100) })],
        unreadCount: 1,
      });
      render(<NotificationBell />);
      await flush(1500);

      expect(callsTo('/api/notifications/read-by-path')).toHaveLength(0);
    });

    it('auto-reads a cached notification when the route changes, without a toast', async () => {
      setFeed({
        notifications: [makeNotification({ id: 'later', createdAt: minutesAgo(100) })],
        unreadCount: 1,
      });
      const { rerender } = render(<NotificationBell />);
      await flush(1);

      nav.pathname = '/cases/case-1';
      rerender(<NotificationBell />);
      await flush(1500);

      expect(callsTo('/api/notifications/read-by-path')).toHaveLength(1);
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    });
  });

  describe('live arrival', () => {
    it('highlights the row and rings, without a toast, when the panel is open', async () => {
      setFeed({ notifications: [], unreadCount: 0 });
      const user = setup();
      render(<NotificationBell />);
      await flush(1);

      await user.click(screen.getByRole('button', { name: 'Notifications' }));
      await flush(1);

      setFeed({
        notifications: [
          makeNotification({
            id: 'live',
            title: 'Just arrived',
            createdAt: new Date(Date.now() + 5000).toISOString(),
          }),
        ],
        unreadCount: 1,
        lastSeenAt: null,
      });
      await flush(30_000);

      const row = screen.getByText('Just arrived').closest('button');
      expect(row).toHaveAttribute('data-highlighted', 'true');
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(document.querySelector('[data-ringing]')).not.toBeNull();

      await flush(2500);
      expect(row).not.toHaveAttribute('data-highlighted');
    });

    it('merges a second live arrival into one toast', async () => {
      const user = setup();
      render(<NotificationBell />);
      await flush(1);

      setFeed({
        notifications: [
          makeNotification({
            id: 'a',
            title: 'First live',
            createdAt: new Date(Date.now() + 1000).toISOString(),
          }),
        ],
        unreadCount: 1,
      });
      await flush(30_000);
      expect(screen.getByRole('status')).toHaveTextContent('First live');
      await user.hover(screen.getByText('First live'));

      setFeed({
        notifications: [
          makeNotification({
            id: 'b',
            title: 'Second live',
            createdAt: new Date(Date.now() + 1000).toISOString(),
          }),
          ...feed.notifications,
        ],
        unreadCount: 2,
      });
      await flush(30_000);

      expect(screen.getAllByRole('status')).toHaveLength(1);
      expect(screen.getByRole('status')).toHaveTextContent('2 new updates');
      expect(track).toHaveBeenLastCalledWith(NOTIFICATION_EVENTS.TOAST_SHOWN, {
        count: 2,
        trigger: 'live',
      });
    });

    it('rings the bell and pings the badge on arrival', async () => {
      setFeed({
        notifications: threeUnseen(),
        unreadCount: 3,
        unseenCount: 3,
      });
      render(<NotificationBell />);
      await flush(701);

      expect(document.querySelector('[data-ringing="true"]')).not.toBeNull();
      expect(document.querySelector('[data-slot="bell-ping"]')).not.toBeNull();
    });
  });

  describe('hidden tab', () => {
    it('polls at the slow rate, titles the tab and defers the toast until visible', async () => {
      setFeed({ notifications: [], unreadCount: 0 });
      render(<NotificationBell />);
      await flush(1);
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(feedFetches()).toHaveLength(1);

      setFeed({
        notifications: [
          makeNotification({
            id: 'h',
            title: 'While away',
            createdAt: new Date(Date.now() + 1000).toISOString(),
          }),
        ],
        unreadCount: 2,
      });
      await flush(30_000);
      expect(feedFetches()).toHaveLength(1);

      await flush(30_000);
      expect(feedFetches()).toHaveLength(2);
      expect(document.title).toBe('(2) Balo');
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(track).not.toHaveBeenCalledWith(NOTIFICATION_EVENTS.TOAST_SHOWN, expect.anything());

      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await flush(1);

      expect(feedFetches()).toHaveLength(3);
      expect(screen.getByRole('status')).toHaveTextContent('While away');
      expect(track).toHaveBeenCalledWith(NOTIFICATION_EVENTS.TOAST_SHOWN, {
        count: 1,
        trigger: 'live',
      });
    });

    it('restores the title on unmount', async () => {
      setFeed({
        notifications: [makeNotification({ createdAt: minutesAgo(100) })],
        unreadCount: 4,
      });
      const { unmount } = render(<NotificationBell />);
      await flush(1);
      expect(document.title).toBe('(4) Balo');

      unmount();

      expect(document.title).toBe('Balo');
    });
  });

  describe('toast behaviour', () => {
    function unseenFeed() {
      setFeed({
        notifications: [
          makeNotification({ id: 'n', title: 'Fresh case', createdAt: minutesAgo(1) }),
        ],
        unreadCount: 1,
        unseenCount: 1,
      });
    }

    it('dismisses with close and marks nothing read', async () => {
      unseenFeed();
      const user = setup();
      render(<NotificationBell />);
      await flush(701);

      await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Dismiss' }));

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(track).toHaveBeenCalledWith(NOTIFICATION_EVENTS.TOAST_DISMISSED, {
        count: 1,
        reason: 'close',
      });
      expect(callsTo('/api/notifications/n/read')).toHaveLength(0);
    });

    it('times out after 8 seconds, and hover pauses the timer', async () => {
      unseenFeed();
      const user = setup();
      render(<NotificationBell />);
      await flush(701);

      await user.hover(screen.getByText('Fresh case'));
      await flush(9000);
      expect(screen.getByRole('status')).toHaveTextContent('Fresh case');

      await user.unhover(screen.getByText('Fresh case'));
      await flush(8100);

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(track).toHaveBeenCalledWith(NOTIFICATION_EVENTS.TOAST_DISMISSED, {
        count: 1,
        reason: 'timeout',
      });
    });

    it('opens the notification from the toast button', async () => {
      unseenFeed();
      const user = setup();
      render(<NotificationBell />);
      await flush(701);

      await user.click(screen.getByRole('button', { name: 'Open case' }));

      expect(mockFetch).toHaveBeenCalledWith('/api/notifications/n/read', { method: 'PATCH' });
      expect(track).toHaveBeenCalledWith(NOTIFICATION_EVENTS.CLICKED, {
        event: 'booking.confirmed',
        source: 'toast',
      });
      expect(mockPush).toHaveBeenCalledWith('/cases/case-1');
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });

    it('opens the panel from the collapsed toast', async () => {
      setFeed({ notifications: threeUnseen(), unreadCount: 3, unseenCount: 3 });
      const user = setup();
      render(<NotificationBell />);
      await flush(701);

      await user.click(screen.getByRole('button', { name: 'Open notifications' }));

      expect(await screen.findByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(track).toHaveBeenCalledWith(NOTIFICATION_EVENTS.PANEL_OPENED, {
        unread_count: 3,
        source: 'toast',
      });
      expect(track).not.toHaveBeenCalledWith(
        NOTIFICATION_EVENTS.TOAST_DISMISSED,
        expect.anything()
      );
    });

    it('omits the action button when the notification has no actionUrl', async () => {
      setFeed({
        notifications: [makeNotification({ actionUrl: null, createdAt: minutesAgo(1) })],
        unreadCount: 1,
        unseenCount: 1,
      });
      render(<NotificationBell />);
      await flush(701);

      const toast = screen.getByRole('status');
      expect(within(toast).getByText('New booking')).toBeInTheDocument();
      expect(within(toast).getAllByRole('button')).toHaveLength(1);
    });
  });

  describe('toast layout', () => {
    function unseenFeed(overrides: Record<string, unknown> = {}) {
      setFeed({
        notifications: [
          makeNotification({
            id: 'n',
            title: 'Fresh case',
            createdAt: minutesAgo(1),
            ...overrides,
          }),
        ],
        unreadCount: 1,
        unseenCount: 1,
      });
    }

    it('pins the toast to the viewport below sm and keeps the bell anchor from sm up', async () => {
      unseenFeed();
      render(<NotificationBell />);
      await flush(701);

      const wrapper = screen.getByRole('status');
      expect(wrapper).toHaveClass('absolute', 'right-0', 'w-[360px]');
      expect(wrapper).toHaveClass('max-sm:fixed', 'max-sm:inset-x-4', 'max-sm:w-auto');
    });

    it('reserves room for the larger dismiss button below md', async () => {
      unseenFeed();
      render(<NotificationBell />);
      await flush(701);

      const textColumn = screen.getByText('Fresh case').parentElement;
      expect(textColumn).toHaveClass('pr-10', 'md:pr-6');
    });

    it('renders no body paragraph when the notification has no body', async () => {
      unseenFeed({ body: null });
      render(<NotificationBell />);
      await flush(701);

      const toast = screen.getByRole('status');
      expect(within(toast).getByText('Fresh case')).toBeInTheDocument();
      expect(toast.querySelectorAll('p')).toHaveLength(1);
    });

    it('lowers the displayed count as toast items are read, then switches to the item layout', async () => {
      setFeed({
        notifications: [
          makeNotification({
            id: 'n1',
            title: 'Alpha',
            actionUrl: '/cases/a',
            createdAt: minutesAgo(3),
          }),
          makeNotification({
            id: 'n2',
            title: 'Bravo',
            actionUrl: '/cases/b',
            createdAt: minutesAgo(2),
          }),
          makeNotification({
            id: 'n3',
            title: 'Charlie',
            actionUrl: '/cases/c',
            createdAt: minutesAgo(1),
          }),
        ],
        unreadCount: 3,
        unseenCount: 3,
      });
      const { rerender } = render(<NotificationBell />);
      await flush(701);
      expect(screen.getByRole('status')).toHaveTextContent('3 updates since your last visit');

      readByPathIds = ['n3'];
      nav.pathname = '/cases/c';
      rerender(<NotificationBell />);
      await flush(1);
      expect(screen.getByRole('status')).toHaveTextContent('2 updates since your last visit');
      expect(screen.getByRole('button', { name: 'Open notifications' })).toBeInTheDocument();

      nav.pathname = '/cases/b';
      rerender(<NotificationBell />);
      await flush(1);
      const toast = screen.getByRole('status');
      expect(toast).not.toHaveTextContent('updates since your last visit');
      expect(within(toast).getByText('Alpha')).toBeInTheDocument();
      expect(within(toast).getByRole('button', { name: 'Open case' })).toBeInTheDocument();
    });

    it('clears the toast once every item has been read', async () => {
      unseenFeed({ actionUrl: '/cases/a' });
      const { rerender } = render(<NotificationBell />);
      await flush(701);
      expect(screen.getByRole('status')).toHaveTextContent('Fresh case');

      nav.pathname = '/cases/a';
      rerender(<NotificationBell />);
      await flush(1);

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });
  });

  describe('toast focus and pause', () => {
    function unseenFeed() {
      setFeed({
        notifications: [
          makeNotification({ id: 'n', title: 'Fresh case', createdAt: minutesAgo(1) }),
        ],
        unreadCount: 1,
        unseenCount: 1,
      });
    }

    it('returns focus to the bell when the dismiss button is used from the keyboard', async () => {
      unseenFeed();
      const user = setup();
      render(<NotificationBell />);
      await flush(701);

      const dismiss = within(screen.getByRole('status')).getByRole('button', { name: 'Dismiss' });
      act(() => dismiss.focus());
      await user.keyboard('{Enter}');

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(screen.getByRole('button', { name: '1 unread notification' })).toHaveFocus();
    });

    it('dismisses with close on Escape inside the toast and returns focus to the bell', async () => {
      unseenFeed();
      const user = setup();
      render(<NotificationBell />);
      await flush(701);

      const action = within(screen.getByRole('status')).getByRole('button', { name: 'Open case' });
      act(() => action.focus());
      await user.keyboard('{Escape}');

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(track).toHaveBeenCalledWith(NOTIFICATION_EVENTS.TOAST_DISMISSED, {
        count: 1,
        reason: 'close',
      });
      expect(screen.getByRole('button', { name: '1 unread notification' })).toHaveFocus();
    });

    it('keeps the timer paused while focus is inside even after the pointer leaves', async () => {
      unseenFeed();
      const user = setup();
      render(<NotificationBell />);
      await flush(701);

      const dismiss = within(screen.getByRole('status')).getByRole('button', { name: 'Dismiss' });
      await user.hover(dismiss);
      act(() => dismiss.focus());
      await user.unhover(dismiss);
      await flush(9000);
      expect(screen.getByRole('status')).toHaveTextContent('Fresh case');

      act(() => dismiss.blur());
      await flush(8100);

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(track).toHaveBeenCalledWith(NOTIFICATION_EVENTS.TOAST_DISMISSED, {
        count: 1,
        reason: 'timeout',
      });
    });
  });

  describe('announcement races and failures', () => {
    it('drops items read before the load toast fires and shows nothing when none remain', async () => {
      setFeed({
        notifications: [
          makeNotification({
            id: 'n',
            title: 'Fresh case',
            actionUrl: '/cases/a',
            createdAt: minutesAgo(1),
          }),
        ],
        unreadCount: 1,
        unseenCount: 1,
      });
      const { rerender } = render(<NotificationBell />);
      await flush(100);

      nav.pathname = '/cases/a';
      rerender(<NotificationBell />);
      await flush(700);

      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(track).not.toHaveBeenCalledWith(NOTIFICATION_EVENTS.TOAST_SHOWN, expect.anything());
      expect(document.querySelector('[data-ringing]')).toBeNull();
      expect(callsTo('/api/notifications/seen')).toHaveLength(0);
    });

    it('announces only the items still unread when the load toast fires', async () => {
      setFeed({
        notifications: [
          makeNotification({
            id: 'n1',
            title: 'Alpha',
            actionUrl: '/cases/a',
            createdAt: minutesAgo(2),
          }),
          makeNotification({
            id: 'n2',
            title: 'Bravo',
            actionUrl: '/cases/b',
            createdAt: minutesAgo(1),
          }),
        ],
        unreadCount: 2,
        unseenCount: 2,
      });
      const { rerender } = render(<NotificationBell />);
      await flush(100);

      readByPathIds = ['n1'];
      nav.pathname = '/cases/a';
      rerender(<NotificationBell />);
      await flush(700);

      expect(screen.getByRole('status')).toHaveTextContent('Bravo');
      expect(track).toHaveBeenCalledWith(NOTIFICATION_EVENTS.TOAST_SHOWN, {
        count: 1,
        trigger: 'load',
      });
    });

    it('keeps the loaded list when a later poll fails', async () => {
      setFeed({
        notifications: [
          makeNotification({ id: 'kept', title: 'Still here', createdAt: minutesAgo(100) }),
        ],
        unreadCount: 1,
      });
      const user = setup();
      render(<NotificationBell />);
      await flush(1);

      mockFetch.mockImplementation(() => Promise.reject(new Error('offline')));
      await flush(30_000);
      await user.click(screen.getByRole('button', { name: '1 unread notification' }));

      expect(await screen.findByText('Still here')).toBeInTheDocument();
      expect(screen.queryByText('Failed to load notifications')).not.toBeInTheDocument();
    });

    it('reads a live arrival on the current path silently, without a toast or ring', async () => {
      nav.pathname = '/cases/case-1';
      render(<NotificationBell />);
      await flush(1);

      readByPathIds = ['live'];
      setFeed({
        notifications: [
          makeNotification({
            id: 'live',
            title: 'Right here',
            actionUrl: '/cases/case-1',
            createdAt: new Date(Date.now() + 5000).toISOString(),
          }),
        ],
        unreadCount: 1,
      });
      await flush(30_000);

      const [, init] = callsTo('/api/notifications/read-by-path')[0] ?? [];
      expect(JSON.parse(String(init?.body))).toEqual({ path: '/cases/case-1' });
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(document.querySelector('[data-ringing]')).toBeNull();
      expect(track).not.toHaveBeenCalledWith(NOTIFICATION_EVENTS.TOAST_SHOWN, expect.anything());
    });
  });

  describe('reduced motion', () => {
    it('shows the toast without ring, ping or slide', async () => {
      motionState.reduced = true;
      setFeed({
        notifications: [makeNotification({ title: 'Fresh case', createdAt: minutesAgo(1) })],
        unreadCount: 1,
        unseenCount: 1,
      });
      render(<NotificationBell />);
      await flush(701);

      expect(screen.getByRole('status')).toHaveTextContent('Fresh case');
      expect(document.querySelector('[data-slot="bell-ping"]')).toBeNull();
      expect(document.querySelector('[data-ringing]')).toBeNull();
      expect(document.querySelector('[data-slot="arrival-toast"]')).toHaveAttribute(
        'data-animated',
        'false'
      );
    });
  });
});
