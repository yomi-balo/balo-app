'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { ChevronRight, Clock, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import type { ProjectsInboxLens, ProjectsInboxFilter } from '@/lib/analytics';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import type { PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';
import { StageChip } from './stage-chip';

/**
 * ListRow — one row of the COMPLETE ranked portfolio list (the design's
 * `ListRow`). Carries TWO distinct chips: `<StageChip>` (WHERE in the pipeline)
 * + a nudge chip (WHAT to do) — needs-you rows get the gradient nudge chip, the
 * rest get a quiet `Clock` + status. Unread dot, truncated title,
 * `updatedRelative` on the right (desktop). Needs-you rows appear here AND in the
 * hero (promotion). Fires `inbox_list_row_clicked`. Engagement rows (including
 * retainers) always carry an `/engagements/{id}?entry=inbox` href, so they are
 * navigable; the `row.href === null` branch is defensive-only.
 */

interface ListRowProps {
  row: PortfolioRowView;
  lens: ProjectsInboxLens;
  fromFilter: ProjectsInboxFilter;
  last: boolean;
}

export function ListRow({
  row,
  lens,
  fromFilter,
  last,
}: Readonly<ListRowProps>): React.JSX.Element {
  const handleClick = useCallback(() => {
    track(PROJECTS_INBOX_EVENTS.INBOX_LIST_ROW_CLICKED, {
      lens,
      request_id: row.kind === 'engagement' ? null : row.id,
      stage: row.stage,
      needs_you: row.needsYou,
      from_filter: fromFilter,
    });
  }, [lens, row.kind, row.id, row.stage, row.needsYou, fromFilter]);

  const rowBody = (
    <>
      <span
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          row.unread ? 'bg-primary animate-pulse' : 'bg-transparent'
        )}
        aria-hidden={!row.unread}
        aria-label={row.unread ? 'Unread activity' : undefined}
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-foreground truncate text-sm',
            row.needsYou ? 'font-semibold' : 'font-medium'
          )}
        >
          {row.title}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {row.companyName && (
            <span className="text-muted-foreground text-xs">{row.companyName}</span>
          )}
          <StageChip stage={row.stage} label={row.stageLabel} />
          {row.progressLabel && (
            <span className="text-muted-foreground text-xs tabular-nums">{row.progressLabel}</span>
          )}
          <span className="text-muted-foreground text-xs sm:hidden">{row.updatedRelative}</span>
        </div>
      </div>
      {row.needsYou ? (
        <span
          className={cn(
            'inline-flex max-w-[60%] min-w-0 shrink items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold shadow-sm sm:max-w-none sm:shrink-0',
            PROPOSAL_CTA_GRADIENT_CLASS
          )}
        >
          <Zap className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{row.nudgeLabel}</span>
        </span>
      ) : (
        <span className="text-muted-foreground hidden shrink-0 items-center gap-1.5 text-xs sm:inline-flex">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {row.nudgeLabel}
        </span>
      )}
      <span className="text-muted-foreground hidden w-14 shrink-0 text-right text-xs sm:inline">
        {row.updatedRelative}
      </span>
      <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
    </>
  );

  const baseClass = cn(
    'flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors',
    !last && 'border-border border-b',
    row.href !== null &&
      'hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
  );

  if (row.href === null) {
    return (
      <div className={cn(baseClass, 'opacity-80')} aria-disabled="true">
        {rowBody}
      </div>
    );
  }

  return (
    <Link href={row.href} onClick={handleClick} className={baseClass}>
      {rowBody}
    </Link>
  );
}
