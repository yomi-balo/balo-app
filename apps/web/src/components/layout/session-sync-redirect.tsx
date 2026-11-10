'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import * as Sentry from '@sentry/nextjs';
import { Button } from '@/components/ui/button';

const STUCK_AFTER_MS = 10_000;
export const SESSION_SYNC_HOPS_KEY = 'balo:session-sync-hops';
const HOP_WINDOW_MS = 30_000;
const MAX_HOPS = 2;

function readRecentHops(now: number): number[] {
  try {
    const raw = globalThis.sessionStorage.getItem(SESSION_SYNC_HOPS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is number => typeof t === 'number' && now - t < HOP_WINDOW_MS);
  } catch {
    return [];
  }
}

function recordHops(hops: number[]): void {
  try {
    globalThis.sessionStorage.setItem(SESSION_SYNC_HOPS_KEY, JSON.stringify(hops));
  } catch {
    // Storage unavailable: the loop breaker is best-effort.
  }
}

function clearHops(): void {
  try {
    globalThis.sessionStorage.removeItem(SESSION_SYNC_HOPS_KEY);
  } catch {
    // Storage unavailable: nothing to clear.
  }
}

/**
 * Hard-navigates to the session-sync route handler, which can mutate the session cookie, then
 * returns to the current path. A full document load is deliberate: an RSC `redirect()` thrown
 * from a cached layout segment is re-thrown on every client navigation and loops.
 *
 * Recent hops are timestamped in `sessionStorage`; once `MAX_HOPS` fall inside `HOP_WINDOW_MS`
 * the sync is not converging, so navigation stops and the retry anchor shows immediately.
 * Otherwise, if the navigation has not completed after `STUCK_AFTER_MS`, the same anchor
 * offers a manual retry.
 */
export function SessionSyncRedirect(): React.JSX.Element {
  const started = useRef(false);
  const syncUrl = useRef<string | null>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (!started.current) {
      started.current = true;
      const { pathname, search } = globalThis.location;
      syncUrl.current = `/api/auth/session-sync?returnTo=${encodeURIComponent(pathname + search)}`;
      const now = Date.now();
      const kept = readRecentHops(now);
      if (kept.length >= MAX_HOPS) {
        setStuck(true);
        Sentry.captureMessage('Session sync did not converge', {
          level: 'warning',
          extra: { hops: kept.length, pathname },
        });
        return;
      }
      recordHops([...kept, now]);
      globalThis.location.replace(syncUrl.current);
    }
    const timer = setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      role="status"
      className="bg-background text-muted-foreground flex min-h-dvh flex-col items-center justify-center gap-3"
    >
      <Loader2 className="size-6 animate-spin" aria-hidden="true" />
      <span className="text-sm">Refreshing your session…</span>
      {stuck && syncUrl.current !== null ? (
        <>
          <span className="text-sm">This is taking longer than usual.</span>
          <Button asChild variant="outline">
            <a href={syncUrl.current} onClick={clearHops}>
              Try again
            </a>
          </Button>
        </>
      ) : null}
    </div>
  );
}
