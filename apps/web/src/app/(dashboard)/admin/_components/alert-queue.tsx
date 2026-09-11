'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { AlertRow } from './alert-row';
import type { AdminQueueCursor, AdminQueueRowView } from '../_lib/admin-queue-view';
import { loadMoreAdminAlerts } from '../_actions/load-more-admin-alerts';

interface AlertQueueProps {
  readonly initialRows: readonly AdminQueueRowView[];
  readonly initialHasMore: boolean;
  readonly initialCursor: AdminQueueCursor | null;
  readonly kinds: readonly string[] | undefined;
  readonly canResolve: boolean;
  /** From `?open=` — the row to expand on first render. */
  readonly initialOpenId: string | null;
}

/**
 * BAL-548 / ADR-1055 — the queue's accumulated row list: one-expanded-at-a-time, keyset "Load
 * more" in `ADMIN_ALERT_PAGE_SIZE` (50) chunks, and a client-side removal of a row the instant
 * its close succeeds (the sweep — or the next full navigation — is the source of truth; this
 * is an optimistic UI courtesy, not a second write path).
 *
 * `'use client'` for the interactive bits only: the list itself is plain markup inside a Card
 * shell (`rounded-2xl border divide-y`), matching `catalogue-list.tsx` / `promo-codes-shell.tsx`.
 */
export function AlertQueue({
  initialRows,
  initialHasMore,
  initialCursor,
  kinds,
  canResolve,
  initialOpenId,
}: Readonly<AlertQueueProps>): React.JSX.Element {
  const [rows, setRows] = useState(initialRows);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [cursor, setCursor] = useState(initialCursor);
  const [expandedId, setExpandedId] = useState<string | null>(initialOpenId);
  const [loadingMore, setLoadingMore] = useState(false);

  function handleClosed(alertId: string): void {
    setRows((current) => current.filter((row) => row.id !== alertId));
    if (expandedId === alertId) {
      setExpandedId(null);
    }
  }

  async function handleLoadMore(): Promise<void> {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      const result = await loadMoreAdminAlerts({
        kinds,
        afterFirstSeenAtIso: cursor.firstSeenAtIso,
        afterId: cursor.id,
      });
      if (result.success) {
        setRows((current) => [...current, ...result.rows]);
        setHasMore(result.hasMore);
        setCursor(result.nextCursor);
      } else {
        toast.error(result.error);
      }
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        data-testid="admin-alert-queue"
        className="border-border bg-card divide-border divide-y overflow-hidden rounded-2xl border"
      >
        {rows.map((row, index) => (
          <AlertRow
            key={row.id}
            row={row}
            index={index}
            last={index === rows.length - 1}
            expanded={expandedId === row.id}
            onToggle={() => setExpandedId((current) => (current === row.id ? null : row.id))}
            canResolve={canResolve}
            onClosed={handleClosed}
          />
        ))}
      </div>
      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="self-center"
          disabled={loadingMore}
          onClick={() => void handleLoadMore()}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
