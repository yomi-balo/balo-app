import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from '@/test/axe';
import { NotificationBell } from './notification-bell';

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/dashboard',
}));

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function notification(id: string, title: string, createdAt: string, readAt: string | null = null) {
  return {
    id,
    event: 'booking.confirmed',
    title,
    body: `${title} body`,
    actionUrl: `/cases/${id}`,
    readAt,
    createdAt,
  };
}

function serve(notifications: ReturnType<typeof notification>[], unseenCount: number): void {
  const unreadCount = notifications.filter((n) => n.readAt === null).length;
  mockFetch.mockImplementation((input: string, init?: RequestInit) => {
    const body = input.startsWith('/api/notifications?')
      ? { notifications, unreadCount, lastSeenAt: minutesAgo(60), unseenCount }
      : {
          lastSeenAt: init?.body
            ? (JSON.parse(String(init.body)) as { through: string }).through
            : null,
        };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('NotificationBell accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has no violations with an open panel showing New and Earlier', async () => {
    serve(
      [
        notification('a', 'Fresh', minutesAgo(100)),
        notification('b', 'Seen already', minutesAgo(200), minutesAgo(150)),
      ],
      0
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<NotificationBell />);
    await flush(1);

    await user.click(screen.getByRole('button', { name: '1 unread notification' }));
    await screen.findByRole('dialog', { name: 'Notifications' });

    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('has no violations with a visible item toast', async () => {
    serve([notification('a', 'Fresh', minutesAgo(1))], 1);
    render(<NotificationBell />);
    await flush(701);

    expect(screen.getByRole('status')).toHaveTextContent('Fresh');
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('has no violations with a visible collapsed toast', async () => {
    serve(
      [
        notification('a', 'Alpha', minutesAgo(3)),
        notification('b', 'Bravo', minutesAgo(2)),
        notification('c', 'Charlie', minutesAgo(1)),
      ],
      3
    );
    render(<NotificationBell />);
    await flush(701);

    expect(screen.getByRole('status')).toHaveTextContent('3 updates since your last visit');
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
