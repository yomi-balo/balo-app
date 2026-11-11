'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { joinWindowOpensAt } from '@balo/shared/engagements';
import { MEETINGS_CHANGED_EVENT } from '@/lib/meetings/meetings-changed-event';
import type { NavCallsResponse } from '@/lib/meetings/nav-call-view-types';

/** A route change refetches only when the last fetch is at least this old. */
export const NAV_CALLS_PATHNAME_REFETCH_MIN_MS = 60_000;

const NAV_CALLS_URL = '/api/meetings/nav-calls';

interface Received {
  readonly response: NavCallsResponse;
  /** Device `Date.now()` when the response landed — the anchor for the window-open timers. */
  readonly receivedAtMs: number;
}

export interface NavCalls {
  /** `null` while loading, after a sign-out (401), or before the first successful read. */
  readonly data: NavCallsResponse | null;
  readonly refetch: () => void;
}

/**
 * BAL-636 — the top-nav call pill's feed. NO polling of its own: it refetches on mount, when the
 * tab becomes visible, on a route change (throttled), when the notification feed signals a
 * meeting change (`MEETINGS_CHANGED_EVENT`, unthrottled), and once at each future join-window
 * opening. A failed or non-OK refetch keeps the previous data — nav chrome should not flicker away
 * on a blip — except a 401, which clears it.
 */
export function useNavCalls(): NavCalls {
  const pathname = usePathname();
  const [received, setReceived] = useState<Received | null>(null);
  const fetchSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const lastFetchAtRef = useRef(0);
  const lastPathnameRef = useRef(pathname);

  const refetch = useCallback((): void => {
    fetchSeqRef.current += 1;
    const seq = fetchSeqRef.current;
    lastFetchAtRef.current = Date.now();

    const run = async (): Promise<void> => {
      let res: Response;
      try {
        res = await fetch(NAV_CALLS_URL, { cache: 'no-store' });
      } catch {
        return;
      }
      if (!mountedRef.current || seq !== fetchSeqRef.current) return;
      if (res.status === 401) {
        setReceived(null);
        return;
      }
      if (!res.ok) return;

      let response: NavCallsResponse;
      try {
        response = (await res.json()) as NavCallsResponse;
      } catch (error) {
        Sentry.captureException(error);
        return;
      }
      if (!mountedRef.current || seq !== fetchSeqRef.current) return;
      setReceived({ response, receivedAtMs: Date.now() });
    };
    run().catch((error: unknown) => Sentry.captureException(error));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refetch();
    return () => {
      mountedRef.current = false;
    };
  }, [refetch]);

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refetch();
    };
    document.addEventListener('visibilitychange', onVisibility);
    globalThis.addEventListener(MEETINGS_CHANGED_EVENT, refetch);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      globalThis.removeEventListener(MEETINGS_CHANGED_EVENT, refetch);
    };
  }, [refetch]);

  useEffect(() => {
    if (lastPathnameRef.current === pathname) return;
    lastPathnameRef.current = pathname;
    if (Date.now() - lastFetchAtRef.current >= NAV_CALLS_PATHNAME_REFETCH_MIN_MS) refetch();
  }, [pathname, refetch]);

  useEffect(() => {
    if (received === null) return undefined;
    const { response, receivedAtMs } = received;
    const serverNowMs = new Date(response.serverNowIso).getTime();
    const elapsedMs = Date.now() - receivedAtMs;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const call of response.calls) {
      const opensAtMs = joinWindowOpensAt(new Date(call.scheduledStart)).getTime();
      const delayMs = opensAtMs - serverNowMs - elapsedMs;
      if (delayMs > 0) timers.push(setTimeout(refetch, delayMs));
    }
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [received, refetch]);

  return { data: received?.response ?? null, refetch };
}
