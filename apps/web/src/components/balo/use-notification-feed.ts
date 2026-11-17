'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { track, NOTIFICATION_EVENTS } from '@/lib/analytics';
import { isAutoReadablePath } from '@/lib/notifications/auto-read-path';
import {
  dispatchMeetingsChanged,
  hasNewMeetingChange,
} from '@/lib/meetings/meetings-changed-event';
import {
  LOAD_TOAST_DELAY_MS,
  PUSH_REFETCH_DEBOUNCE_MS,
  ROW_HIGHLIGHT_MS,
  liveLatencyMs,
  notificationActionPath,
  pollDelayMs,
  seenThroughNow,
  selectUnseenNotifications,
  type ArrivalSource,
  type ArrivalToastDismissReason,
  type PanelOpenSource,
  type ArrivalToastState,
  type BellNotification,
  type NotificationsResponse,
} from './notification-arrival';
import { useNotificationPush } from './use-notification-push';

type FeedStatus = 'loading' | 'error' | 'ready';

export interface NotificationFeed {
  notifications: BellNotification[];
  unreadCount: number;
  status: FeedStatus;
  toast: ArrivalToastState | null;
  toastItems: BellNotification[];
  ringKey: number;
  highlightedIds: ReadonlySet<string>;
  panelOpen: boolean;
  openPanel: (source: PanelOpenSource) => void;
  closePanel: () => void;
  dismissToast: (reason: ArrivalToastDismissReason) => void;
  openNotification: (notification: BellNotification, source: ArrivalSource) => void;
  markAllRead: () => void;
  retry: () => void;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/** What triggered a feed fetch: a realtime ping, or the poll / panel / retry paths. */
type FetchSource = 'push' | 'poll';

interface LiveToastMeta {
  transport: FetchSource;
  latencyMs: number;
}

function isHidden(): boolean {
  return document.visibilityState === 'hidden';
}

/** Runs a background task whose outcome nobody awaits; a failure is reported, never left unhandled. */
function detach(task: Promise<unknown>): void {
  task.catch((error: unknown) => {
    Sentry.captureException(error);
  });
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function readLastSeenAt(data: unknown): number | null {
  if (typeof data !== 'object' || data === null || !('lastSeenAt' in data)) return null;
  const { lastSeenAt } = data;
  return typeof lastSeenAt === 'string' ? Date.parse(lastSeenAt) : null;
}

function readReadIdsCount(data: unknown): number {
  if (typeof data !== 'object' || data === null || !('readIds' in data)) return 0;
  const { readIds } = data;
  return Array.isArray(readIds) ? readIds.length : 0;
}

/**
 * Owns the bell's fetch, polling, seen cursor, auto-read and announcement flow. Every announcement
 * decision reads refs, so the callbacks stay stable and the poll loop never restarts on a render.
 */
export function useNotificationFeed({
  realtimeUserId = null,
}: Readonly<{ realtimeUserId?: string | null }> = {}): NotificationFeed {
  const router = useRouter();
  const pathname = usePathname() ?? '';

  const [notifications, setNotifications] = useState<BellNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [status, setStatus] = useState<FeedStatus>('loading');
  const [toast, setToast] = useState<ArrivalToastState | null>(null);
  const [ringKey, setRingKey] = useState(0);
  const [highlightedIds, setHighlightedIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [panelOpen, setPanelOpen] = useState(false);

  const listRef = useRef<BellNotification[]>([]);
  const toastRef = useRef<ArrivalToastState | null>(null);
  const panelOpenRef = useRef(false);
  const pathnameRef = useRef(pathname);
  const cursorRef = useRef<number | null>(null);
  const announcedIdsRef = useRef(new Set<string>());
  const meetingSignalIdsRef = useRef<Set<string> | null>(null);
  const autoReadAttemptedRef = useRef(new Set<string>());
  const loadPendingRef = useRef(true);
  const toastKeyRef = useRef(0);
  const fetchSeqRef = useRef(0);
  const mountedRef = useRef(false);
  const impersonatingRef = useRef(false);
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pushDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pushLiveRef = useRef(false);
  const rescheduleRef = useRef<(() => void) | null>(null);

  const commitList = useCallback((next: BellNotification[]): void => {
    listRef.current = next;
    setNotifications(next);
  }, []);

  const commitToast = useCallback((next: ArrivalToastState | null): void => {
    toastRef.current = next;
    setToast(next);
  }, []);

  const commitPanelOpen = useCallback((next: boolean): void => {
    panelOpenRef.current = next;
    setPanelOpen(next);
  }, []);

  const advanceCursor = useCallback((ms: number): void => {
    if (Number.isNaN(ms)) return;
    cursorRef.current = Math.max(cursorRef.current ?? ms, ms);
  }, []);

  const markAnnounced = useCallback((ids: readonly string[]): void => {
    for (const id of ids) announcedIdsRef.current.add(id);
  }, []);

  const schedule = useCallback((ms: number, run: () => void): void => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      if (mountedRef.current) run();
    }, ms);
    timersRef.current.add(timer);
  }, []);

  const postSeen = useCallback(
    (through: Date): void => {
      if (impersonatingRef.current) return;
      detach(
        postJson('/api/notifications/seen', { through: through.toISOString() }).then((data) => {
          const lastSeenAt = readLastSeenAt(data);
          if (lastSeenAt !== null) advanceCursor(lastSeenAt);
        })
      );
    },
    [advanceCursor]
  );

  const showToast = useCallback(
    (next: Omit<ArrivalToastState, 'key'>, live?: LiveToastMeta): void => {
      toastKeyRef.current += 1;
      commitToast({ ...next, key: toastKeyRef.current });
      setRingKey((key) => key + 1);
      if (live === undefined) {
        track(NOTIFICATION_EVENTS.TOAST_SHOWN, { count: next.count, trigger: 'load' });
      } else {
        track(NOTIFICATION_EVENTS.TOAST_SHOWN, {
          count: next.count,
          trigger: 'live',
          transport: live.transport,
          latency_ms: live.latencyMs,
        });
      }
    },
    [commitToast]
  );

  const applyAutoRead = useCallback(
    (list: BellNotification[]): { list: BellNotification[]; matched: BellNotification[] } => {
      const path = pathnameRef.current;
      const matched =
        path && isAutoReadablePath(path) && !impersonatingRef.current
          ? list.filter(
              (n) =>
                n.readAt === null &&
                !autoReadAttemptedRef.current.has(n.id) &&
                notificationActionPath(n.actionUrl) === path
            )
          : [];
      if (matched.length === 0) return { list, matched };

      const ids = matched.map((n) => n.id);
      for (const id of ids) autoReadAttemptedRef.current.add(id);
      markAnnounced(ids);
      detach(
        postJson('/api/notifications/read-by-path', { path }).then((data) => {
          const count = readReadIdsCount(data);
          if (count > 0) track(NOTIFICATION_EVENTS.AUTO_READ, { count });
        })
      );

      const readAt = new Date().toISOString();
      const matchedIds = new Set(ids);
      return {
        list: list.map((n) => (matchedIds.has(n.id) ? { ...n, readAt } : n)),
        matched,
      };
    },
    [markAnnounced]
  );

  const announceLoad = useCallback(
    (
      list: BellNotification[],
      cursor: number | null,
      unseenCount: number,
      excludedCount: number
    ): void => {
      if (cursor === null) {
        markAnnounced(list.map((n) => n.id));
        postSeen(seenThroughNow(list));
        return;
      }
      const unseen = selectUnseenNotifications(list, new Date(cursor), announcedIdsRef.current);
      const [newest] = unseen;
      if (newest === undefined) return;

      const ids = unseen.map((n) => n.id);
      markAnnounced(ids);
      const count = Math.max(unseen.length, unseenCount - excludedCount);
      schedule(LOAD_TOAST_DELAY_MS, () => {
        if (panelOpenRef.current || impersonatingRef.current) return;
        if (isHidden()) {
          for (const id of ids) announcedIdsRef.current.delete(id);
          loadPendingRef.current = true;
          return;
        }
        const unreadIds = new Set(
          listRef.current.filter((n) => n.readAt === null).map((n) => n.id)
        );
        const remaining = ids.filter((id) => unreadIds.has(id));
        if (remaining.length === 0) return;
        showToast({
          ids: remaining,
          count: Math.max(remaining.length, count - (ids.length - remaining.length)),
          trigger: 'load',
        });
        postSeen(new Date(newest.createdAt));
      });
    },
    [markAnnounced, postSeen, schedule, showToast]
  );

  const announceLive = useCallback(
    (list: BellNotification[], cursor: number | null, source: FetchSource): void => {
      const unseen = selectUnseenNotifications(
        list,
        new Date(cursor ?? 0),
        announcedIdsRef.current
      );
      const [newest] = unseen;
      if (newest === undefined) return;

      const ids = unseen.map((n) => n.id);
      markAnnounced(ids);
      if (panelOpenRef.current) {
        clearTimeout(highlightTimerRef.current);
        setHighlightedIds(new Set(ids));
        highlightTimerRef.current = setTimeout(
          () => setHighlightedIds(EMPTY_IDS),
          ROW_HIGHLIGHT_MS
        );
        setRingKey((key) => key + 1);
      } else {
        const previous = toastRef.current;
        showToast(
          {
            ids: [...ids, ...(previous?.ids ?? [])],
            count: (previous?.count ?? 0) + unseen.length,
            trigger: 'live',
          },
          { transport: source, latencyMs: liveLatencyMs(unseen, Date.now()) }
        );
      }
      postSeen(new Date(newest.createdAt));
    },
    [markAnnounced, postSeen, showToast]
  );

  const processResponse = useCallback(
    (data: NotificationsResponse, source: FetchSource): void => {
      impersonatingRef.current = data.impersonating === true;
      if (data.lastSeenAt) advanceCursor(Date.parse(data.lastSeenAt));
      const cursor = cursorRef.current;
      const { list, matched } = applyAutoRead(data.notifications ?? []);
      const excludedCount =
        cursor === null ? 0 : matched.filter((n) => Date.parse(n.createdAt) > cursor).length;

      commitList(list);
      setUnreadCount(Math.max(0, (data.unreadCount ?? 0) - matched.length));

      // The call pill refetches on this signal. It fires from a hidden tab too, so the pill is
      // current when the viewer returns; the first load only seeds the known ids.
      if (hasNewMeetingChange(meetingSignalIdsRef.current, list)) dispatchMeetingsChanged();
      meetingSignalIdsRef.current = new Set(list.map((n) => n.id));

      if (isHidden() || impersonatingRef.current) return;
      if (loadPendingRef.current) {
        loadPendingRef.current = false;
        announceLoad(list, cursor, data.unseenCount ?? 0, excludedCount);
        return;
      }
      announceLive(list, cursor, source);
    },
    [advanceCursor, announceLive, announceLoad, applyAutoRead, commitList]
  );

  const fetchFeed = useCallback(
    async (source: FetchSource = 'poll'): Promise<void> => {
      fetchSeqRef.current += 1;
      const seq = fetchSeqRef.current;
      let data: NotificationsResponse;
      try {
        const res = await fetch('/api/notifications?limit=20');
        if (!res.ok) throw new Error('Failed to fetch');
        data = (await res.json()) as NotificationsResponse;
      } catch {
        if (mountedRef.current && seq === fetchSeqRef.current) {
          setStatus((current) => (current === 'ready' ? current : 'error'));
        }
        return;
      }
      if (!mountedRef.current || seq !== fetchSeqRef.current) return;
      try {
        processResponse(data, source);
      } catch (error) {
        Sentry.captureException(error);
      }
      setStatus('ready');
    },
    [processResponse]
  );

  useEffect(() => {
    mountedRef.current = true;
    const timers = timersRef.current;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = (): void => {
      clearTimeout(pollTimer);
      if (cancelled) return;
      const delay = pollDelayMs({ hidden: isHidden(), pushLive: pushLiveRef.current });
      pollTimer = setTimeout(() => {
        detach(fetchFeed().finally(scheduleNext));
      }, delay);
    };
    rescheduleRef.current = scheduleNext;

    const onVisibilityChange = (): void => {
      if (isHidden()) {
        scheduleNext();
        return;
      }
      clearTimeout(pollTimer);
      detach(fetchFeed().finally(scheduleNext));
    };

    detach(fetchFeed().finally(scheduleNext));
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      mountedRef.current = false;
      rescheduleRef.current = null;
      clearTimeout(pollTimer);
      clearTimeout(highlightTimerRef.current);
      clearTimeout(pushDebounceRef.current);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchFeed]);

  // A ping restarts one trailing timer, so a burst of notifications costs a single refetch.
  const onPushCreated = useCallback((): void => {
    clearTimeout(pushDebounceRef.current);
    pushDebounceRef.current = setTimeout(() => {
      detach(fetchFeed('push'));
    }, PUSH_REFETCH_DEBOUNCE_MS);
  }, [fetchFeed]);

  const { pushLive } = useNotificationPush({ userId: realtimeUserId, onCreated: onPushCreated });

  // The poll cadence follows the connection state, and the timer restarts from NOW on a change so
  // a stale 120s wait is never sat out after a drop. Ephemeral pings skip Ably's resume, and a row
  // can land between the mount fetch and the first connect, so every transition to live does one
  // catch-up fetch first.
  useEffect(() => {
    if (pushLiveRef.current === pushLive) return;
    pushLiveRef.current = pushLive;
    if (pushLive) detach(fetchFeed('poll'));
    rescheduleRef.current?.();
  }, [pushLive, fetchFeed]);

  useEffect(() => {
    if (panelOpen) detach(fetchFeed());
  }, [panelOpen, fetchFeed]);

  useEffect(() => {
    pathnameRef.current = pathname;
    const { list, matched } = applyAutoRead(listRef.current);
    if (matched.length === 0) return;
    commitList(list);
    setUnreadCount((count) => Math.max(0, count - matched.length));
  }, [pathname, applyAutoRead, commitList]);

  const toastItems = useMemo((): BellNotification[] => {
    if (!toast) return [];
    const byId = new Map(notifications.map((n) => [n.id, n]));
    return toast.ids
      .map((id) => byId.get(id))
      .filter((n): n is BellNotification => n?.readAt === null);
  }, [toast, notifications]);

  useEffect(() => {
    if (toast && toastItems.length === 0) commitToast(null);
  }, [toast, toastItems, commitToast]);

  const openPanel = useCallback(
    (source: PanelOpenSource): void => {
      commitToast(null);
      clearTimeout(highlightTimerRef.current);
      setHighlightedIds(EMPTY_IDS);
      commitPanelOpen(true);
      markAnnounced(listRef.current.map((n) => n.id));
      postSeen(seenThroughNow(listRef.current));
      track(NOTIFICATION_EVENTS.PANEL_OPENED, { unread_count: unreadCount, source });
    },
    [commitPanelOpen, commitToast, markAnnounced, postSeen, unreadCount]
  );

  const closePanel = useCallback((): void => commitPanelOpen(false), [commitPanelOpen]);

  const dismissToast = useCallback(
    (reason: ArrivalToastDismissReason): void => {
      const current = toastRef.current;
      if (!current) return;
      commitToast(null);
      track(NOTIFICATION_EVENTS.TOAST_DISMISSED, { count: current.count, reason });
    },
    [commitToast]
  );

  const openNotification = useCallback(
    (notification: BellNotification, source: ArrivalSource): void => {
      if (notification.readAt === null) {
        const readAt = new Date().toISOString();
        commitList(listRef.current.map((n) => (n.id === notification.id ? { ...n, readAt } : n)));
        setUnreadCount((count) => Math.max(0, count - 1));
        fetch(`/api/notifications/${notification.id}/read`, { method: 'PATCH' }).catch(() => {
          detach(fetchFeed());
        });
      }
      track(NOTIFICATION_EVENTS.CLICKED, { event: notification.event, source });
      commitPanelOpen(false);
      commitToast(null);
      if (notification.actionUrl) router.push(notification.actionUrl);
    },
    [commitList, commitPanelOpen, commitToast, fetchFeed, router]
  );

  const markAllRead = useCallback((): void => {
    const readAt = new Date().toISOString();
    commitList(listRef.current.map((n) => (n.readAt === null ? { ...n, readAt } : n)));
    setUnreadCount(0);
    fetch('/api/notifications/read-all', { method: 'POST' }).catch(() => {
      detach(fetchFeed());
    });
  }, [commitList, fetchFeed]);

  const retry = useCallback((): void => {
    detach(fetchFeed());
  }, [fetchFeed]);

  return {
    notifications,
    unreadCount,
    status,
    toast,
    toastItems,
    ringKey,
    highlightedIds,
    panelOpen,
    openPanel,
    closePanel,
    dismissToast,
    openNotification,
    markAllRead,
    retry,
  };
}
