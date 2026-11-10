'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

const STUCK_AFTER_MS = 10_000;

/**
 * Hard-navigates to the session-sync route handler, which can mutate the session cookie, then
 * returns to the current path. A full document load is deliberate: an RSC `redirect()` thrown
 * from a cached layout segment is re-thrown on every client navigation and loops.
 *
 * If the navigation has not completed after `STUCK_AFTER_MS`, a plain anchor to the same URL
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
            <a href={syncUrl.current}>Try again</a>
          </Button>
        </>
      ) : null}
    </div>
  );
}
