'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { toast } from 'sonner';
import { readCallNowRingAction } from '@/app/(call)/meetings/[meetingId]/call/_actions/read-call-now-ring';
import { CALL_NOW_EVENTS, track } from '@/lib/analytics';
import { declineCallNowRingAction } from '@/lib/call-now/actions/decline-call-now-ring';
import { readIncomingCallAction } from '@/lib/call-now/actions/read-incoming-call';
import { markAnswerIntent } from '@/lib/call-now/answer-intent';
import type { IncomingCallView } from '@/lib/call-now/call-now-types';
import { CALL_TOAST_COPY } from '@/lib/call-now/call-toast-copy';
import type { BellNotification } from '../notification-arrival';
import {
  PENDING_MISSED_GRACE_MS,
  selectCallToast,
  type CallToastView,
  type MissedToastView,
  type RingingToastView,
} from './call-toast-model';

type ShowTrigger = 'live' | 'load';

const EMPTY_IDS: ReadonlySet<string> = new Set();

interface UseCallToastArgs {
  notifications: readonly BellNotification[];
  /** Staff viewing as the user: the toast renders nothing and no ring is read. `null` until the feed
   * has said either way; nothing is read while it is unknown. */
  impersonating: boolean | null;
  /** The feed's `markRead`: optimistic, with a refetch on failure. */
  markRead: (ids: readonly string[]) => void;
}

export interface CallToastController {
  view: CallToastView | null;
  join: (view: RingingToastView) => void;
  decline: (view: RingingToastView) => void;
  dismiss: (view: MissedToastView) => void;
  callBack: (view: MissedToastView) => void;
}

function withId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return set.has(id) ? set : new Set([...set, id]);
}

function ringIdOf(row: BellNotification): string | null {
  return row.call?.ringId ?? null;
}

function viewKeyOf(view: CallToastView): string {
  return view.mode === 'ringing' ? `ringing:${view.ringId}` : view.key;
}

function report(error: unknown): void {
  Sentry.captureException(error);
}

/**
 * The call toast's state: the live ring read on mount and on every new unread `call.ringing` row,
 * the ringing → missed hand-over, and the four actions.
 *
 * The sticky truth is the unread `call.no_answer` row. A ring that lapses while the page is open
 * is shown as a PENDING-MISSED toast built from the cached ring until its row arrives (or
 * {@link PENDING_MISSED_GRACE_MS} passes), so the toast morphs in place rather than blinking out.
 * Every ring end is confirmed against the ring read first, so a ring that was declined, stopped
 * or connected elsewhere clears instead of turning missed. Nothing here ever navigates by itself.
 */
export function useCallToast({
  notifications,
  impersonating,
  markRead,
}: Readonly<UseCallToastArgs>): CallToastController {
  const router = useRouter();
  const [incoming, setIncoming] = useState<IncomingCallView | null>(null);
  const [pendingMissed, setPendingMissed] = useState<IncomingCallView | null>(null);
  const [declined, setDeclined] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const aliveRef = useRef(true);
  const mountedAtRef = useRef(Date.now());
  const mountSettledRef = useRef(false);
  const incomingRef = useRef<IncomingCallView | null>(null);
  const declinedRef = useRef<ReadonlySet<string>>(EMPTY_IDS);
  const handledRowsRef = useRef(new Set<string>());
  const settlingRef = useRef<string | null>(null);
  const triggerByRingRef = useRef(new Map<string, ShowTrigger>());
  const shownRef = useRef(new Set<string>());
  const lateMarkedRef = useRef(new Set<string>());

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    incomingRef.current = incoming;
  }, [incoming]);

  const loadIncoming = useCallback(async (trigger: ShowTrigger): Promise<void> => {
    try {
      const next = await readIncomingCallAction();
      if (!aliveRef.current || next === null) return;
      if (declinedRef.current.has(next.ringId)) return;
      if (incomingRef.current?.ringId === next.ringId) return;
      triggerByRingRef.current.set(next.ringId, trigger);
      incomingRef.current = next;
      setNowMs(Date.now());
      setIncoming(next);
      setPendingMissed(null);
    } catch (error) {
      report(error);
    }
  }, []);

  useEffect(() => {
    if (impersonating !== false) return;
    loadIncoming('load').finally(() => {
      mountSettledRef.current = true;
    });
  }, [impersonating, loadIncoming]);

  useEffect(() => {
    if (impersonating !== false) return;
    for (const row of notifications) {
      if (row.event !== 'call.ringing' || row.readAt !== null) continue;
      if (handledRowsRef.current.has(row.id)) continue;
      handledRowsRef.current.add(row.id);
      const ringId = ringIdOf(row);
      if (ringId !== null && incomingRef.current?.ringId === ringId) continue;
      loadIncoming(mountSettledRef.current ? 'live' : 'load').catch(report);
    }
  }, [notifications, impersonating, loadIncoming]);

  const settle = useCallback(async (view: IncomingCallView): Promise<void> => {
    if (settlingRef.current === view.ringId) return;
    settlingRef.current = view.ringId;
    let missed = false;
    try {
      const result = await readCallNowRingAction({ ringId: view.ringId });
      const lapsed = Date.now() >= Date.parse(view.expiresAtIso);
      if (result.ok && result.status === 'ringing' && !lapsed) {
        settlingRef.current = null;
        return;
      }
      missed =
        result.ok && (result.status === 'unanswered' || (result.status === 'ringing' && lapsed));
    } catch (error) {
      report(error);
    }
    if (!aliveRef.current) return;
    setNowMs(Math.max(Date.now(), Date.parse(view.expiresAtIso)));
    setIncoming((current) => (current?.ringId === view.ringId ? null : current));
    if (missed && !declinedRef.current.has(view.ringId)) setPendingMissed(view);
  }, []);

  const incomingRingId = incoming?.ringId ?? null;
  const incomingExpiresAt = incoming?.expiresAtIso ?? null;
  const ringRowRead = useMemo(
    () =>
      incomingRingId !== null &&
      notifications.some(
        (row) =>
          row.event === 'call.ringing' && row.call?.ringId === incomingRingId && row.readAt !== null
      ),
    [notifications, incomingRingId]
  );

  useEffect(() => {
    const current = incomingRef.current;
    if (current === null || incomingRingId === null || incomingExpiresAt === null) return undefined;
    if (ringRowRead) settle(current).catch(report);
    const timer = setTimeout(
      () => settle(current).catch(report),
      Math.max(0, Date.parse(incomingExpiresAt) - Date.now())
    );
    return () => clearTimeout(timer);
  }, [incomingRingId, incomingExpiresAt, ringRowRead, settle]);

  const pendingRingId = pendingMissed?.ringId ?? null;
  const pendingRowArrived = useMemo(
    () =>
      pendingRingId !== null &&
      notifications.some(
        (row) => row.event === 'call.no_answer' && row.call?.ringId === pendingRingId
      ),
    [notifications, pendingRingId]
  );

  useEffect(() => {
    if (pendingRingId === null) return undefined;
    if (pendingRowArrived) {
      setPendingMissed(null);
      return undefined;
    }
    const timer = setTimeout(() => setPendingMissed(null), PENDING_MISSED_GRACE_MS);
    return () => clearTimeout(timer);
  }, [pendingRingId, pendingRowArrived]);

  useEffect(() => {
    if (dismissed.size === 0) return;
    const late = notifications
      .filter(
        (row) =>
          row.event === 'call.no_answer' &&
          row.readAt === null &&
          dismissed.has(ringIdOf(row) ?? '') &&
          !lateMarkedRef.current.has(row.id)
      )
      .map((row) => row.id);
    if (late.length === 0) return;
    for (const id of late) lateMarkedRef.current.add(id);
    markRead(late);
  }, [notifications, dismissed, markRead]);

  const view = useMemo(
    () =>
      impersonating !== false
        ? null
        : selectCallToast({
            incoming,
            pendingMissed,
            rows: notifications,
            nowMs,
            declinedRingIds: declined,
            dismissedRingIds: dismissed,
          }),
    [impersonating, incoming, pendingMissed, notifications, nowMs, declined, dismissed]
  );

  useEffect(() => {
    if (view === null) return;
    const key = viewKeyOf(view);
    if (shownRef.current.has(key)) return;
    shownRef.current.add(key);
    track(CALL_NOW_EVENTS.TOAST_SHOWN, {
      mode: view.mode,
      trigger: shownTrigger(view, triggerByRingRef.current, notifications, mountedAtRef.current),
    });
  }, [view, notifications]);

  const join = useCallback((ring: RingingToastView): void => {
    const intent = ring.lens === 'client' && ring.awaitsAnswer;
    track(CALL_NOW_EVENTS.TOAST_JOIN_CLICKED, {
      lens: ring.lens,
      awaits_answer: ring.awaitsAnswer,
    });
    if (intent) markAnswerIntent({ meetingId: ring.meetingId, ringId: ring.ringId });
  }, []);

  const decline = useCallback((ring: RingingToastView): void => {
    const next = withId(declinedRef.current, ring.ringId);
    declinedRef.current = next;
    setDeclined(next);
    track(CALL_NOW_EVENTS.TOAST_DECLINED, { lens: ring.lens });
    declineCallNowRingAction({ ringId: ring.ringId })
      .then((result) => {
        if (result.ok) toast.success(CALL_TOAST_COPY.declined(ring.callerLabel));
        else toast.error(CALL_TOAST_COPY.declineFailed(ring.callerLabel));
      })
      .catch((error: unknown) => {
        report(error);
        toast.error(CALL_TOAST_COPY.declineFailed(ring.callerLabel));
      });
  }, []);

  const clearMissed = useCallback(
    (missed: MissedToastView): void => {
      for (const id of missed.rowIds) lateMarkedRef.current.add(id);
      markRead(missed.rowIds);
      const ringIds = [
        ...(missed.ringId === null ? [] : [missed.ringId]),
        ...notifications
          .filter((row) => missed.rowIds.includes(row.id))
          .flatMap((row) => ringIdOf(row) ?? []),
      ];
      if (ringIds.length > 0) setDismissed((current) => new Set([...current, ...ringIds]));
      setPendingMissed(null);
    },
    [markRead, notifications]
  );

  const dismiss = useCallback(
    (missed: MissedToastView): void => {
      track(CALL_NOW_EVENTS.MISSED_TOAST_DISMISSED, { missed_count: missed.count });
      clearMissed(missed);
    },
    [clearMissed]
  );

  const callBack = useCallback(
    (missed: MissedToastView): void => {
      track(CALL_NOW_EVENTS.MISSED_CALL_BACK_CLICKED, { missed_count: missed.count });
      clearMissed(missed);
      if (missed.engagementId !== null) router.push(`/cases/${missed.engagementId}?call=1`);
    },
    [clearMissed, router]
  );

  return { view, join, decline, dismiss, callBack };
}

function shownTrigger(
  view: CallToastView,
  triggerByRing: ReadonlyMap<string, ShowTrigger>,
  rows: readonly BellNotification[],
  mountedAtMs: number
): ShowTrigger {
  if (view.mode === 'ringing') return triggerByRing.get(view.ringId) ?? 'load';
  if (view.pending) return 'live';
  const newest = rows.find((row) => row.id === view.rowIds[0]);
  return newest !== undefined && Date.parse(newest.createdAt) >= mountedAtMs ? 'live' : 'load';
}
