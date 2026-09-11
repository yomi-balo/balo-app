'use client';

import { useCallback, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HealthRow } from './health-row';
import { RedriveSheet } from './redrive-sheet';
import type { CaptureHealthCategory } from '@balo/shared/capture-health';
import type { CaptureHealthRowView } from '../_lib/capture-health-view';
import type { CaptureHealthCursorDTO } from '../_lib/load-capture-health';
import { useRedriveSheet } from '../_lib/use-redrive-sheet';
import { loadMoreCaptureHealth } from '../_actions/load-more-capture-health';

/**
 * BAL-550 (§7.1) — the accumulating, load-more list. Client (load-more state, the open sheet,
 * the optimistic post-confirm chip). `HealthRow`/`LadderChip` carry no hooks, so the SERVER
 * pinned band (`PinnedHealthRow`) can render them too, sharing `useRedriveSheet`.
 */
interface HealthListProps {
  readonly initialRows: readonly CaptureHealthRowView[];
  readonly initialHasMore: boolean;
  readonly initialCursor: CaptureHealthCursorDTO | null;
  readonly fromIso: string;
  readonly toIso: string;
  readonly category: CaptureHealthCategory | null;
  readonly withheldBeforeIso: string;
  readonly canRedrive: boolean;
  readonly actorLabel: string;
}

export function HealthList({
  initialRows,
  initialHasMore,
  initialCursor,
  fromIso,
  toIso,
  category,
  withheldBeforeIso,
  canRedrive,
  actorLabel,
}: Readonly<HealthListProps>): React.JSX.Element {
  const [rows, setRows] = useState(initialRows);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [cursor, setCursor] = useState(initialCursor);
  const [loadingMore, startLoadMore] = useTransition();

  const handleRowUpdated = useCallback((updated: CaptureHealthRowView): void => {
    setRows((prev) => prev.map((r) => (r.meetingId === updated.meetingId ? updated : r)));
  }, []);
  const { sheetTarget, pending, openSheet, closeSheet, confirm } =
    useRedriveSheet(handleRowUpdated);

  const handleLoadMore = useCallback((): void => {
    if (cursor === null) return;
    startLoadMore(async () => {
      const result = await loadMoreCaptureHealth({
        cursor,
        fromIso,
        toIso,
        category,
        withheldBeforeIso,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setRows((prev) => [...prev, ...result.rows]);
      setHasMore(result.hasMore);
      setCursor(result.nextCursor);
    });
  }, [cursor, fromIso, toIso, category, withheldBeforeIso]);

  return (
    <div>
      <div className="border-border bg-card overflow-hidden rounded-2xl border">
        {rows.map((row, index) => (
          <HealthRow
            key={row.meetingId}
            row={row}
            index={index}
            last={index === rows.length - 1 && !hasMore}
            canRedrive={canRedrive}
            onRedrive={openSheet}
          />
        ))}
      </div>

      {hasMore && (
        <div className="mt-3 flex justify-center">
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={handleLoadMore}>
            {loadingMore ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                Loading…
              </>
            ) : (
              'Load more'
            )}
          </Button>
        </div>
      )}

      <RedriveSheet
        target={sheetTarget}
        actorLabel={actorLabel}
        pending={pending}
        onConfirm={confirm}
        onOpenChange={(open) => {
          if (!open) closeSheet();
        }}
      />
    </div>
  );
}
