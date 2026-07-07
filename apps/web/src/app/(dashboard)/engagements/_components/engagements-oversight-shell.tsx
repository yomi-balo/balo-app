'use client';

import { useCallback, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Filter, RotateCcw, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  oversightRowMatchesFilter,
  type EngagementsOversightDTO,
  type OversightCounts,
  type OversightFilter,
} from '@/lib/engagements/oversight-row';
import { OversightTiles } from './oversight-tiles';
import { EngagementRow } from './engagement-row';
import { FilteredEmptyState, ZeroEmptyState } from './oversight-empty-states';
import { AdminEngagementsAnalytics } from './admin-engagements-analytics';

/**
 * EngagementsOversightShell — the page root for the admin engagements oversight
 * list (BAL-335). Client component (the tiles/filter are interactive; the DTO
 * arrives fully serialised from the server loader). Owns the `in_flight`
 * composite-default filter, renders the header + the ONE emphasised
 * next-best-action chip (chase stalled → review in-review → none), the tiles, and
 * the filtered rows in a card (or a per-filter invitation when the slice is
 * empty). A true-zero DTO renders the `ZeroEmptyState` instead of tiles + list.
 * Mounts the analytics island in every branch so the view always tracks.
 */

interface EngagementsOversightShellProps {
  dto: EngagementsOversightDTO;
}

const FILTER_LABEL: Record<OversightFilter, string> = {
  in_flight: 'In flight',
  active: 'Active',
  in_review: 'In review',
  stalled: 'Stalled',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

interface NextBestAction {
  filter: OversightFilter;
  label: string;
  /** 'warm' → amber→red gradient (chase); 'amber' → flat warning (review). */
  tone: 'warm' | 'amber';
}

/** The single emphasised action: chase stalled first, else review in-review, else none. */
function nextBestAction(counts: OversightCounts): NextBestAction | null {
  if (counts.stalled > 0) {
    return { filter: 'stalled', label: `Chase ${counts.stalled} stalled`, tone: 'warm' };
  }
  if (counts.inReview > 0) {
    return { filter: 'in_review', label: `${counts.inReview} in client review`, tone: 'amber' };
  }
  return null;
}

function OversightHeader(): React.JSX.Element {
  return (
    <div>
      <h1 className="text-foreground text-2xl font-semibold">Engagements</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Delivery oversight — what&apos;s in flight, in review, or gone quiet.
      </p>
    </div>
  );
}

export function EngagementsOversightShell({
  dto,
}: Readonly<EngagementsOversightShellProps>): React.JSX.Element {
  const [filter, setFilter] = useState<OversightFilter>('in_flight');

  const handleSelect = useCallback((next: OversightFilter) => setFilter(next), []);
  const handleClear = useCallback(() => setFilter('in_flight'), []);

  const visibleRows = useMemo(
    () => dto.rows.filter((row) => oversightRowMatchesFilter(row, filter)),
    [dto.rows, filter]
  );

  if (dto.isEmpty) {
    return (
      <div className="flex flex-col gap-6">
        <AdminEngagementsAnalytics filter={filter} counts={dto.counts} />
        <OversightHeader />
        <ZeroEmptyState />
      </div>
    );
  }

  const action = nextBestAction(dto.counts);

  return (
    <div className="flex flex-col gap-5">
      <AdminEngagementsAnalytics filter={filter} counts={dto.counts} />

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex flex-wrap items-end justify-between gap-3"
      >
        <OversightHeader />
        {action !== null && (
          <button
            type="button"
            onClick={() => setFilter(action.filter)}
            className={cn(
              'focus-visible:ring-ring inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition-all focus-visible:ring-2 focus-visible:outline-none',
              action.tone === 'warm'
                ? 'from-warning to-destructive bg-gradient-to-r text-white'
                : 'bg-warning text-warning-foreground'
            )}
          >
            <Zap className="h-4 w-4" aria-hidden="true" />
            {action.label}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </motion.div>

      <OversightTiles counts={dto.counts} filter={filter} onSelect={handleSelect} />

      <div>
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Filter className="text-muted-foreground h-4 w-4" aria-hidden="true" />
            <span className="text-muted-foreground text-xs font-bold tracking-wider uppercase">
              {FILTER_LABEL[filter]} · {visibleRows.length}
            </span>
          </div>
          {filter !== 'in_flight' && (
            <button
              type="button"
              onClick={handleClear}
              className="text-primary focus-visible:ring-ring inline-flex items-center gap-1 rounded text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Back to in flight
            </button>
          )}
        </div>

        {visibleRows.length > 0 ? (
          <div className="border-border bg-card overflow-hidden rounded-2xl border">
            {visibleRows.map((row, index) => (
              <EngagementRow key={row.id} row={row} last={index === visibleRows.length - 1} />
            ))}
          </div>
        ) : (
          <FilteredEmptyState filter={filter} onClear={handleClear} />
        )}
      </div>
    </div>
  );
}
