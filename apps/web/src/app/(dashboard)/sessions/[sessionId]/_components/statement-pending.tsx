'use client';

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { STATEMENT_COPY } from '../_lib/statement-copy';

const MAX_ATTEMPTS = 3;
const ATTEMPT_INTERVAL_MS = 15_000;

/**
 * D-B — the bounded pending poller. NO new endpoint: `router.refresh()` re-runs the RSC and
 * re-reads the same statement; once the server returns a finalized tree, this island is
 * replaced and the timer dies with the unmount.
 *
 * ⚠ HARD BOUND: at most 3 attempts at ~15s, then the timer is cleared and NEVER re-armed for
 * the life of the mount — a hard stop, not a backoff. An abandoned tab must not become
 * expensive (owner rationale). The manual Refresh button works before, during and after the
 * polling window.
 */
export function StatementPending({
  lens,
}: Readonly<{ lens: 'client' | 'expert' }>): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const attemptsRef = useRef(0);
  // ⚠ THE HALF-INTERVAL OF SLACK IS LOAD-BEARING, NOT COSMETIC. The Nth on-time tick lands at
  // EXACTLY `N * ATTEMPT_INTERVAL_MS`, so a bare `now + MAX_ATTEMPTS * ATTEMPT_INTERVAL_MS`
  // deadline is already `>=` on the final tick and swallows it — the poller then makes
  // MAX_ATTEMPTS - 1 attempts, silently under-delivering the owner's "at most 3" (caught by
  // `statement-pending.test.ts`: expected 3, got 2). The slack admits every on-time tick while
  // still bounding the case this deadline actually exists for: a suspended tab that resumes
  // long after the window and would otherwise fire a burst of stale refreshes. Timer drift
  // makes a bare `>` comparison too fragile to rely on instead.
  const deadlineRef = useRef(
    Date.now() + MAX_ATTEMPTS * ATTEMPT_INTERVAL_MS + ATTEMPT_INTERVAL_MS / 2
  );

  useEffect(() => {
    const timer = setInterval(() => {
      if (attemptsRef.current >= MAX_ATTEMPTS || Date.now() >= deadlineRef.current) {
        clearInterval(timer);
        return;
      }
      attemptsRef.current += 1;
      startTransition(() => router.refresh());
    }, ATTEMPT_INTERVAL_MS);
    return () => clearInterval(timer);
    // Mount-once: the bound is enforced via refs, not by re-arming on a dependency change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = STATEMENT_COPY[lens];

  return (
    <div className="mt-8 flex flex-col items-center gap-4 py-6 text-center">
      {/* <output> carries an implicit role="status" + aria-live="polite" (SonarCloud S6819). */}
      <output className="bg-primary/10 text-primary inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium">
        <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {STATEMENT_COPY[lens].pendingLabel}
      </output>
      <p className="text-muted-foreground max-w-sm text-sm">{copy.pendingBody}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-2"
        disabled={isPending}
        onClick={() => startTransition(() => router.refresh())}
      >
        <RotateCw
          size={14}
          className={isPending ? 'animate-spin motion-reduce:animate-none' : ''}
          aria-hidden="true"
        />
        Refresh
      </Button>
    </div>
  );
}
