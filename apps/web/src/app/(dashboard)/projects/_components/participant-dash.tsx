'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { Briefcase, Check, Clock, Plus, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import type { ProjectsInboxFilter } from '@/lib/analytics';
import {
  rowMatchesFilter,
  type PortfolioDTO,
  type PortfolioFilter,
  type PortfolioRowView,
} from '@/lib/projects-inbox/portfolio-row';
import { StatTiles, type StatTileDescriptor } from './stat-tiles';
import { HeroCard } from './hero-card';
import { ListRow } from './list-row';
import { NEW_REQUEST_HREF } from './constants';

/**
 * ParticipantDash — the client/expert dashboard body (the design's
 * `ParticipantDash`). Holds the tile-filter state and derives the needs / in-
 * progress / kicked slices + the ranked list slice PURELY from the already-ranked
 * `dto.rows` (no refetch — the server did the ORDER BY). The needs-you HERO shows
 * when the filter is `all`/`needs` and needs>0; its items ALSO render, badged, in
 * the list below (promotion, not partition). Fires `inbox_filter_applied` on tile
 * toggle.
 */

interface ParticipantDashProps {
  dto: PortfolioDTO;
}

const FILTER_LABELS: Record<PortfolioFilter, string> = {
  all: 'All',
  needs: 'Needs you',
  in_progress: 'In progress',
  kicked: 'Live projects',
};

function listLabelFor(filter: PortfolioFilter, lens: 'client' | 'expert'): string {
  if (filter === 'all') return lens === 'client' ? 'All requests' : 'All engagements';
  return FILTER_LABELS[filter];
}

export function ParticipantDash({ dto }: Readonly<ParticipantDashProps>): React.JSX.Element {
  const [filter, setFilter] = useState<PortfolioFilter>('all');

  const needsRows = useMemo(() => dto.rows.filter((r) => r.needsYou), [dto.rows]);
  const listRows = useMemo<PortfolioRowView[]>(
    () => dto.rows.filter((r) => rowMatchesFilter(r, filter)),
    [dto.rows, filter]
  );

  const handlePick = useCallback(
    (key: string) => {
      // Clicking the active tile resets to 'all' (the design's toggle behaviour).
      const next: PortfolioFilter = filter === key ? 'all' : (key as PortfolioFilter);
      setFilter(next);
      const resultCount = dto.rows.filter((r) => rowMatchesFilter(r, next)).length;
      track(PROJECTS_INBOX_EVENTS.INBOX_FILTER_APPLIED, {
        lens: dto.lens,
        filter: next as ProjectsInboxFilter,
        result_count: resultCount,
      });
    },
    [filter, dto.rows, dto.lens]
  );

  const tiles: StatTileDescriptor[] = [
    {
      key: 'needs',
      label: 'Needs you',
      count: dto.tiles.needs,
      icon: Zap,
      tone: 'text-primary',
      emphasize: true,
      sub: 'Sorted first',
    },
    {
      key: 'in_progress',
      label: 'In progress',
      count: dto.tiles.inProgress,
      icon: Clock,
      tone: 'text-warning',
      sub: 'Waiting on others',
    },
    {
      key: 'kicked',
      label: 'Kicked off',
      count: dto.tiles.kicked,
      icon: Check,
      tone: 'text-success',
      sub: 'Live projects',
    },
    {
      key: 'all',
      label: 'Total',
      count: dto.tiles.total,
      icon: Briefcase,
      tone: 'text-muted-foreground',
      sub: dto.lens === 'client' ? 'Your requests' : 'Your engagements',
    },
  ];

  const showHero = (filter === 'all' || filter === 'needs') && needsRows.length > 0;

  return (
    <div className="flex flex-col gap-5">
      <StatTiles tiles={tiles} active={filter} onSelect={handlePick} />

      {showHero && (
        <section aria-label="Needs your attention">
          <div className="mb-2.5 flex items-center gap-2">
            <Zap className="text-primary h-4 w-4" aria-hidden="true" />
            <span className="text-primary text-xs font-bold tracking-wider uppercase">
              Needs your attention
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {needsRows.map((row, index) => (
              <HeroCard key={row.id} row={row} lens={dto.lens} index={index} />
            ))}
          </div>
        </section>
      )}

      {listRows.length > 0 && (
        <section aria-label={listLabelFor(filter, dto.lens)}>
          <div className="mb-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs font-bold tracking-wider uppercase">
                {listLabelFor(filter, dto.lens)}
              </span>
              <Badge variant="secondary">{listRows.length}</Badge>
            </div>
            {dto.lens === 'client' && (
              <Button asChild variant="outline" size="sm">
                <Link href={NEW_REQUEST_HREF}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  New request
                </Link>
              </Button>
            )}
          </div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.1 }}
            className="border-border bg-card overflow-hidden rounded-2xl border"
          >
            {listRows.map((row, index) => (
              <ListRow
                key={`${row.kind}-${row.id}`}
                row={row}
                lens={dto.lens}
                fromFilter={filter as ProjectsInboxFilter}
                last={index === listRows.length - 1}
              />
            ))}
          </motion.div>
        </section>
      )}

      {filter === 'needs' && needsRows.length === 0 && (
        <div className="border-border bg-card rounded-2xl border px-6 py-9 text-center">
          <p className="text-foreground text-sm font-semibold">Nothing needs you right now</p>
          <p className="text-muted-foreground mt-1 text-xs">You&apos;re all caught up.</p>
        </div>
      )}
    </div>
  );
}
