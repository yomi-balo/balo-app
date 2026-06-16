'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import type { AdminKanbanCard, AdminKanbanColumn } from '@/lib/projects-inbox/portfolio-row';
import { StageChip } from './stage-chip';

/**
 * PipelineKanban — the admin pipeline mini-kanban (the design's "Pipeline by
 * stage"). Horizontal-scroll columns grouped by stage — the one surface where
 * column-thinking earns its keep ("where is everything stuck"). Cards link to
 * `/projects/{id}`; a stalled card shows a destructive `AlertCircle` pill. Always
 * scrolls horizontally (works at 375px). Fires `inbox_list_row_clicked`.
 */

interface PipelineKanbanProps {
  columns: AdminKanbanColumn[];
}

function KanbanCard({ card }: Readonly<{ card: AdminKanbanCard }>): React.JSX.Element {
  const handleClick = useCallback(() => {
    track(PROJECTS_INBOX_EVENTS.INBOX_LIST_ROW_CLICKED, {
      lens: 'admin',
      request_id: card.id,
      stage: 'pipeline',
      needs_you: card.stalledLabel !== null,
      from_filter: 'all',
    });
  }, [card.id, card.stalledLabel]);

  return (
    <Link
      href={card.href}
      onClick={handleClick}
      className={cn(
        'bg-card focus-visible:ring-ring block rounded-xl border p-3 transition-colors focus-visible:ring-2 focus-visible:outline-none',
        card.stalledLabel !== null
          ? 'border-destructive/40'
          : 'border-border hover:border-primary/40'
      )}
    >
      <p className="text-foreground text-sm leading-snug font-semibold">{card.title}</p>
      <p className="text-muted-foreground mt-1 text-xs">
        {card.companyName ?? 'Unknown company'} · {card.updatedRelative}
      </p>
      {card.stalledLabel !== null && (
        <span className="bg-destructive/10 text-destructive mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold">
          <AlertCircle className="h-3 w-3" aria-hidden="true" />
          {card.stalledLabel}
        </span>
      )}
    </Link>
  );
}

export function PipelineKanban({ columns }: Readonly<PipelineKanbanProps>): React.JSX.Element {
  return (
    <div className="flex gap-3 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
      {columns.map((column, columnIndex) => (
        <motion.div
          key={column.stage}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.14 + columnIndex * 0.05 }}
          className="w-[230px] shrink-0"
        >
          <div className="flex items-center gap-2 px-1 pb-2">
            <StageChip stage={column.stage} label={column.label} />
            <span className="text-muted-foreground text-xs font-bold">{column.items.length}</span>
          </div>
          <div className="bg-muted flex min-h-[110px] flex-col gap-2 rounded-2xl p-2">
            {column.items.length === 0 ? (
              <p className="text-muted-foreground px-2 py-4 text-center text-xs">Nothing here</p>
            ) : (
              column.items.map((card) => <KanbanCard key={card.id} card={card} />)
            )}
          </div>
        </motion.div>
      ))}
    </div>
  );
}
