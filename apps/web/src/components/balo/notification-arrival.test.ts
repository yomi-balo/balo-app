import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatRelativeTime,
  formatUnreadTabTitle,
  notificationActionLabel,
  notificationActionPath,
  notificationKindOf,
  seenThroughNow,
  selectUnseenNotifications,
  stripUnreadTabTitle,
  summariseNotificationTitles,
  type BellNotification,
} from './notification-arrival';

function make(id: string, createdAt: string, readAt: string | null = null): BellNotification {
  return {
    id,
    event: 'booking.confirmed',
    title: id,
    body: null,
    actionUrl: null,
    readAt,
    createdAt,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('notificationActionPath', () => {
  it('returns null for a null url', () => {
    expect(notificationActionPath(null)).toBeNull();
  });

  it('keeps a path with no query', () => {
    expect(notificationActionPath('/cases/c1')).toBe('/cases/c1');
  });

  it('drops everything from the first ?', () => {
    expect(notificationActionPath('/projects/p1?from=notification&x=1')).toBe('/projects/p1');
  });
});

describe('notificationActionLabel', () => {
  it.each([
    ['/meetings/m1/call', 'Join call'],
    ['/meetings/m1?from=notification', 'View recap'],
    ['/meetings/m1/call?x=1', 'Join call'],
    ['/cases/c1', 'Open case'],
    ['/projects/p1', 'View project'],
    ['/projects?lens=admin', 'View'],
    ['/engagements/e1', 'Open workspace'],
    ['/billing/top-up', 'Top up'],
    ['/billing/top-up/confirm', 'Top up'],
    ['/billing/top-upgrade', 'View'],
    ['/settings/billing', 'Open billing'],
    ['/settings/billing/methods', 'Open billing'],
    ['/dashboard', 'View'],
  ])('%s → %s', (url, label) => {
    expect(notificationActionLabel(url)).toBe(label);
  });

  it('returns null when there is no action url', () => {
    expect(notificationActionLabel(null)).toBeNull();
  });
});

describe('notificationKindOf', () => {
  it.each([
    ['booking.confirmed', 'CalendarCheck', 'primary'],
    ['reschedule_proposal.created', 'CalendarCheck', 'primary'],
    ['meeting.started', 'Video', 'primary'],
    ['recap.ready', 'Video', 'primary'],
    ['session.ended', 'Video', 'primary'],
    ['engagement.opened', 'Briefcase', 'primary'],
    ['action_item.assigned', 'Briefcase', 'primary'],
    ['conversation.message', 'MessageSquare', 'info'],
    ['project.created', 'FolderKanban', 'info'],
    ['request_file.uploaded', 'FolderKanban', 'info'],
    ['proposal.sent', 'Sparkles', 'info'],
    ['credit.low', 'Wallet', 'success'],
    ['billing.invoice', 'Wallet', 'success'],
    ['payment.received', 'Wallet', 'success'],
    ['promo.applied', 'Wallet', 'success'],
    ['payout.sent', 'Wallet', 'success'],
    ['calendar.disconnected', 'Link2', 'muted'],
    ['expert.approved', 'UserRound', 'muted'],
    ['onboarding.done', 'UserRound', 'muted'],
    ['user.welcome', 'UserRound', 'muted'],
    ['party.invited', 'Users', 'muted'],
    ['company.joined', 'Users', 'muted'],
    ['agency.joined', 'Users', 'muted'],
    ['review.received', 'Star', 'muted'],
  ])('%s → %s / %s', (event, icon, tone) => {
    expect(notificationKindOf(event)).toEqual({ icon, tone });
  });

  it.each(['', 'unknown', 'unknown.thing'])('falls back to a muted bell for %j', (event) => {
    expect(notificationKindOf(event)).toEqual({ icon: 'Bell', tone: 'muted' });
  });
});

describe('summariseNotificationTitles', () => {
  it('lists two and counts the rest', () => {
    expect(summariseNotificationTitles(['A', 'B', 'C', 'D'], 4)).toBe('A, B and 2 more');
  });

  it('counts distinct titles but the total of notifications', () => {
    expect(summariseNotificationTitles(['A', 'A', 'B'], 3)).toBe('A, B and 1 more');
  });

  it('uses the total for the remainder', () => {
    expect(summariseNotificationTitles(['A', 'B', 'C'], 25)).toBe('A, B and 23 more');
  });

  it('joins exactly two with "and"', () => {
    expect(summariseNotificationTitles(['A', 'B'], 2)).toBe('A and B');
  });

  it('handles a single distinct title with more behind it', () => {
    expect(summariseNotificationTitles(['A', 'A', 'A'], 3)).toBe('A and 2 more');
  });

  it('returns the lone title when nothing else is left', () => {
    expect(summariseNotificationTitles(['A'], 1)).toBe('A');
  });

  it('returns an empty string for no titles', () => {
    expect(summariseNotificationTitles([], 0)).toBe('');
  });
});

describe('formatUnreadTabTitle', () => {
  it('prefixes the unread count', () => {
    expect(formatUnreadTabTitle('Balo', 3)).toBe('(3) Balo');
  });

  it('caps at 9+', () => {
    expect(formatUnreadTabTitle('Balo', 12)).toBe('(9+) Balo');
  });

  it('strips an existing numeric prefix', () => {
    expect(formatUnreadTabTitle('(3) Balo', 5)).toBe('(5) Balo');
  });

  it('strips an existing 9+ prefix', () => {
    expect(formatUnreadTabTitle('(9+) Balo', 2)).toBe('(2) Balo');
  });

  it('leaves the title bare when nothing is unread', () => {
    expect(formatUnreadTabTitle('(4) Balo', 0)).toBe('Balo');
    expect(formatUnreadTabTitle('Balo', 0)).toBe('Balo');
  });

  it('stripUnreadTabTitle leaves an unprefixed title alone', () => {
    expect(stripUnreadTabTitle('Balo (beta)')).toBe('Balo (beta)');
  });
});

describe('selectUnseenNotifications', () => {
  const since = new Date('2026-01-01T10:00:00.000Z');

  it('uses a strict > against the cursor', () => {
    const list = [
      make('at', '2026-01-01T10:00:00.000Z'),
      make('after', '2026-01-01T10:00:00.001Z'),
    ];
    expect(selectUnseenNotifications(list, since, new Set()).map((n) => n.id)).toEqual(['after']);
  });

  it('excludes read and announced notifications', () => {
    const list = [
      make('read', '2026-01-01T11:00:00.000Z', '2026-01-01T11:30:00.000Z'),
      make('announced', '2026-01-01T11:00:00.000Z'),
      make('fresh', '2026-01-01T11:00:00.000Z'),
    ];
    expect(selectUnseenNotifications(list, since, new Set(['announced'])).map((n) => n.id)).toEqual(
      ['fresh']
    );
  });

  it('returns newest first', () => {
    const list = [
      make('old', '2026-01-01T11:00:00.000Z'),
      make('new', '2026-01-01T12:00:00.000Z'),
      make('mid', '2026-01-01T11:30:00.000Z'),
    ];
    expect(selectUnseenNotifications(list, since, new Set()).map((n) => n.id)).toEqual([
      'new',
      'mid',
      'old',
    ]);
  });
});

describe('seenThroughNow', () => {
  it('is now when every notification is older', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    expect(seenThroughNow([make('a', '2026-01-01T00:00:00.000Z')]).toISOString()).toBe(
      '2026-01-02T00:00:00.000Z'
    );
  });

  it('is the newest createdAt when it is ahead of the client clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    expect(seenThroughNow([make('a', '2026-01-03T00:00:00.000Z')]).toISOString()).toBe(
      '2026-01-03T00:00:00.000Z'
    );
  });

  it('is now for an empty list', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    expect(seenThroughNow([]).toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('formatRelativeTime', () => {
  it('buckets minutes, hours and days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00.000Z'));
    expect(formatRelativeTime('2026-01-10T11:59:40.000Z')).toBe('Just now');
    expect(formatRelativeTime('2026-01-10T11:30:00.000Z')).toBe('30m ago');
    expect(formatRelativeTime('2026-01-10T09:00:00.000Z')).toBe('3h ago');
    expect(formatRelativeTime('2026-01-08T12:00:00.000Z')).toBe('2d ago');
  });

  it('falls back to a locale date after a week', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-20T12:00:00.000Z'));
    const iso = '2026-01-01T12:00:00.000Z';
    expect(formatRelativeTime(iso)).toBe(new Date(iso).toLocaleDateString());
  });
});
