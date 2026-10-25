'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { track, NOTIFICATION_EVENTS } from '@/lib/analytics';
import {
  LOAD_TOAST_DELAY_MS,
  POLL_HIDDEN_MS,
  POLL_VISIBLE_MS,
  ROW_HIGHLIGHT_MS,
  notificationActionPath,
  seenThroughNow,
  selectUnseenNotifications,
  type ArrivalSource,
  type ArrivalToastDismissReason,
  type PanelOpenSource,
  type ArrivalToastState,
  type BellNotification,
  type NotificationsResponse,
} from './notification-arrival';

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

function isHidden(): boolean {
  return document.visibilityState === 'hidden';
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
export function useNotificationFeed(): NotificationFeed {
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
  const autoReadAttemptedRef = useRef(new Set<string>());
  const loadPendingRef = useRef(true);
  const toastKeyRef = useRef(0);
  const fetchSeqRef = useRef(0);
  const mountedRef = useRef(false);
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
      postJson('/api/notifications/seen', { through: through.toISOString() }).then((data) => {
        const lastSeenAt = readLastSeenAt(data);
        if (lastSeenAt !== null) advanceCursor(lastSeenAt);
      });
    },
    [advanceCursor]
  );

  const showToast = useCallback(
    (next: Omit<ArrivalToastState, 'key'>): void => {
      toastKeyRef.current += 1;
      commitToast({ ...next, key: toastKeyRef.current });
      setRingKey((key) => key + 1);
      track(NOTIFICATION_EVENTS.TOAST_SHOWN, { count: next.count, trigger: next.trigger });
    },
    [commitToast]
  );

  const applyAutoRead = useCallback(
    (list: BellNotification[]): { list: BellNotification[]; matched: BellNotification[] } => {
      const path = pathnameRef.current;
      const matched = path
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
      postJson('/api/notifications/read-by-path', { path }).then((data) => {
        const count = readReadIdsCount(data);
        if (count > 0) track(NOTIFICATION_EVENTS.AUTO_READ, { count });
      });

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
        if (panelOpenRef.current) return;
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
    (list: BellNotification[], cursor: number | null): void => {
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
        showToast({
          ids: [...ids, ...(previous?.ids ?? [])],
          count: (previous?.count ?? 0) + unseen.length,
          trigger: 'live',
        });
      }
      postSeen(new Date(newest.createdAt));
    },
    [markAnnounced, postSeen, showToast]
  );

  const processResponse = useCallback(
    (data: NotificationsResponse): void => {
      if (data.lastSeenAt) advanceCursor(Date.parse(data.lastSeenAt));
      const cursor = cursorRef.current;
      const { list, matched } = applyAutoRead(data.notifications ?? []);
      const excludedCount =
        cursor === null ? 0 : matched.filter((n) => Date.parse(n.createdAt) > cursor).length;

      commitList(list);
      setUnreadCount(Math.max(0, (data.unreadCount ?? 0) - matched.length));

      if (isHidden()) return;
      if (loadPendingRef.current) {
        loadPendingRef.current = false;
        announceLoad(list, cursor, data.unseenCount ?? 0, excludedCount);
        return;
      }
      announceLive(list, cursor);
    },
    [advanceCursor, announceLive, announceLoad, applyAutoRead, commitList]
  );

  const fetchFeed = useCallback(async (): Promise<void> => {
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
    processResponse(data);
    setStatus('ready');
  }, [processResponse]);

  useEffect(() => {
    mountedRef.current = true;
    const timers = timersRef.current;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = (): void => {
      clearTimeout(pollTimer);
      if (cancelled) return;
      const delay = isHidden() ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
      pollTimer = setTimeout(() => {
        fetchFeed().then(scheduleNext);
      }, delay);
    };

    const onVisibilityChange = (): void => {
      if (isHidden()) {
        scheduleNext();
        return;
      }
      clearTimeout(pollTimer);
      fetchFeed().then(scheduleNext);
    };

    fetchFeed().then(scheduleNext);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      mountedRef.current = false;
      clearTimeout(pollTimer);
      clearTimeout(highlightTimerRef.current);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchFeed]);

  useEffect(() => {
    if (panelOpen) fetchFeed();
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
      .filter((n): n is BellNotification => n !== undefined && n.readAt === null);
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
          fetchFeed();
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
      fetchFeed();
    });
  }, [commitList, fetchFeed]);

  const retry = useCallback((): void => {
    fetchFeed();
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
