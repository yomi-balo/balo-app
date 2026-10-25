import type { NOTIFICATION_EVENTS, NotificationEventMap } from '@/lib/analytics';

export interface BellNotification {
  id: string;
  event: string;
  title: string;
  body: string | null;
  actionUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsResponse {
  notifications: BellNotification[];
  unreadCount: number;
  lastSeenAt: string | null;
  unseenCount: number;
}

export interface ArrivalToastState {
  ids: readonly string[];
  count: number;
  trigger: ArrivalToastTrigger;
  key: number;
}

export type ArrivalToastTrigger =
  NotificationEventMap[typeof NOTIFICATION_EVENTS.TOAST_SHOWN]['trigger'];
export type ArrivalToastDismissReason =
  NotificationEventMap[typeof NOTIFICATION_EVENTS.TOAST_DISMISSED]['reason'];
export type ArrivalSource = NotificationEventMap[typeof NOTIFICATION_EVENTS.CLICKED]['source'];
export type PanelOpenSource =
  NotificationEventMap[typeof NOTIFICATION_EVENTS.PANEL_OPENED]['source'];

export const POLL_VISIBLE_MS = 30_000;
export const POLL_HIDDEN_MS = 60_000;
export const LOAD_TOAST_DELAY_MS = 700;
export const ITEM_TOAST_MS = 8_000;
export const COLLAPSED_TOAST_MS = 10_000;
export const ROW_HIGHLIGHT_MS = 2_400;

/** Every user-facing string of the arrival surface; the one place copy is edited. */
export const NOTIFICATION_ARRIVAL_COPY = {
  panelTitle: 'Notifications',
  openNotifications: 'Open notifications',
  dismiss: 'Dismiss',
  groupNew: 'New',
  groupEarlier: 'Earlier',
  allCaughtUp: 'You’re all caught up.',
  markAllRead: 'Mark all read',
  unread: 'Unread',
  loadFailed: 'Failed to load notifications',
  retry: 'Retry',
  loadHeading: (count: number): string => `${count} updates since your last visit`,
  liveHeading: (count: number): string => `${count} new updates`,
} as const;

export type NotificationKindIcon =
  | 'CalendarCheck'
  | 'Video'
  | 'Briefcase'
  | 'MessageSquare'
  | 'FolderKanban'
  | 'Sparkles'
  | 'Wallet'
  | 'Link2'
  | 'UserRound'
  | 'Users'
  | 'Star'
  | 'Bell';

export type NotificationKindTone = 'primary' | 'info' | 'success' | 'muted';

export interface NotificationKind {
  icon: NotificationKindIcon;
  tone: NotificationKindTone;
}

const FALLBACK_KIND: NotificationKind = { icon: 'Bell', tone: 'muted' };

const KIND_GROUPS: ReadonlyArray<{ namespaces: readonly string[]; kind: NotificationKind }> = [
  {
    namespaces: ['booking', 'reschedule_proposal'],
    kind: { icon: 'CalendarCheck', tone: 'primary' },
  },
  { namespaces: ['meeting', 'recap', 'session'], kind: { icon: 'Video', tone: 'primary' } },
  { namespaces: ['engagement', 'action_item'], kind: { icon: 'Briefcase', tone: 'primary' } },
  { namespaces: ['conversation'], kind: { icon: 'MessageSquare', tone: 'info' } },
  { namespaces: ['project', 'request_file'], kind: { icon: 'FolderKanban', tone: 'info' } },
  { namespaces: ['proposal'], kind: { icon: 'Sparkles', tone: 'info' } },
  {
    namespaces: ['credit', 'billing', 'payment', 'promo', 'payout'],
    kind: { icon: 'Wallet', tone: 'success' },
  },
  { namespaces: ['calendar'], kind: { icon: 'Link2', tone: 'muted' } },
  { namespaces: ['expert', 'onboarding', 'user'], kind: { icon: 'UserRound', tone: 'muted' } },
  { namespaces: ['party', 'company', 'agency'], kind: { icon: 'Users', tone: 'muted' } },
  { namespaces: ['review'], kind: { icon: 'Star', tone: 'muted' } },
];

const KIND_BY_NAMESPACE: ReadonlyMap<string, NotificationKind> = new Map(
  KIND_GROUPS.flatMap(({ namespaces, kind }) =>
    namespaces.map((namespace): [string, NotificationKind] => [namespace, kind])
  )
);

export function notificationKindOf(event: string): NotificationKind {
  const [namespace = ''] = event.split('.');
  return KIND_BY_NAMESPACE.get(namespace) ?? FALLBACK_KIND;
}

export function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

/** The `actionUrl` text before the first `?`, mirroring the repository's `split_part`. */
export function notificationActionPath(actionUrl: string | null): string | null {
  if (actionUrl === null) return null;
  const queryStart = actionUrl.indexOf('?');
  return queryStart === -1 ? actionUrl : actionUrl.slice(0, queryStart);
}

const ACTION_LABELS: ReadonlyArray<{ matches: (path: string) => boolean; label: string }> = [
  { matches: (path) => /^\/meetings\/[^/]+\/call$/.test(path), label: 'Join call' },
  { matches: (path) => path.startsWith('/meetings/'), label: 'View recap' },
  { matches: (path) => path.startsWith('/cases/'), label: 'Open case' },
  { matches: (path) => path.startsWith('/projects/'), label: 'View project' },
  { matches: (path) => path.startsWith('/engagements/'), label: 'Open workspace' },
  {
    matches: (path) => path === '/billing/top-up' || path.startsWith('/billing/top-up/'),
    label: 'Top up',
  },
  { matches: (path) => path.startsWith('/settings/billing'), label: 'Open billing' },
];

export function notificationActionLabel(actionUrl: string | null): string | null {
  const path = notificationActionPath(actionUrl);
  if (path === null) return null;
  return ACTION_LABELS.find((row) => row.matches(path))?.label ?? 'View';
}

/** Unread, created strictly after `since`, not yet announced in this mount; newest first. */
export function selectUnseenNotifications(
  list: readonly BellNotification[],
  since: Date,
  announcedIds: ReadonlySet<string>
): BellNotification[] {
  const sinceMs = since.getTime();
  return list
    .filter(
      (n) => n.readAt === null && Date.parse(n.createdAt) > sinceMs && !announcedIds.has(n.id)
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** "A and B", "A, B and N more" or "A and N more" from the two newest distinct titles. */
export function summariseNotificationTitles(titles: readonly string[], total: number): string {
  const shown = [...new Set(titles)].slice(0, 2);
  const rest = total - shown.length;
  const [first, second] = shown;
  if (first === undefined) return '';
  if (second === undefined) return rest > 0 ? `${first} and ${rest} more` : first;
  return rest > 0 ? `${first}, ${second} and ${rest} more` : `${first} and ${second}`;
}

const TAB_TITLE_PREFIX = /^\((?:\d+|9\+)\) /;

export function stripUnreadTabTitle(title: string): string {
  return title.replace(TAB_TITLE_PREFIX, '');
}

export function formatUnreadTabTitle(title: string, unread: number): string {
  const bare = stripUnreadTabTitle(title);
  if (unread <= 0) return bare;
  return `(${unread > 9 ? '9+' : unread}) ${bare}`;
}

/** Everything cached counts as seen: the later of the newest server `createdAt` and now. */
export function seenThroughNow(list: readonly BellNotification[]): Date {
  const newest = list.reduce((max, n) => Math.max(max, Date.parse(n.createdAt)), 0);
  return new Date(Math.max(newest, Date.now()));
}
