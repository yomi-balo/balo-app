'use client';

import { useCallback, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Activity, AlertCircle, Briefcase, ChevronDown, Clock } from 'lucide-react';
import { BaloCard } from '@/components/balo/card/balo-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import {
  agencyRowMatches,
  type AgencyFilter,
  type AgencyPortfolioDTO,
  type AgencyRowView,
} from '@/lib/projects-inbox/portfolio-row';
import { StatTiles, type StatTileDescriptor } from './stat-tiles';
import { AgencyRow, AGENCY_ROW_GRID, STATE_LABEL } from './agency-row';
import { AgencyPersonFilter, EVERYONE, type AgencyPerson } from './agency-person-filter';
import { AgencyPicker } from './agency-picker';
import { AgencyEmptyState } from './agency-empty-state';
import { cn } from '@/lib/utils';

/**
 * AgencyDash — the agency oversight body (prototype `AgencyView`). Holds the tile and
 * "Delivered by" filter state and derives every slice from the already-ranked DTO rows; the
 * server did the ORDER BY. Tile and person combine with AND, and the person filter also narrows
 * the finished group. The shell keys this on the agency id, so switching agency resets both.
 */

interface AgencyDashProps {
  dto: AgencyPortfolioDTO;
}

const LIST_LABEL: Record<AgencyFilter, string> = {
  all: 'All live projects',
  changes_requested: STATE_LABEL.changes_requested,
  in_delivery: STATE_LABEL.in_delivery,
  pending_acceptance: STATE_LABEL.pending_acceptance,
};

function SectionLabel({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <span className="text-muted-foreground text-xs font-bold tracking-wider uppercase">
      {children}
    </span>
  );
}

function ListHeader(): React.JSX.Element {
  const cell = 'text-muted-foreground text-[11px] font-semibold tracking-wider uppercase';
  return (
    <div
      aria-hidden="true"
      className={cn(
        'border-border/60 bg-muted/50 hidden gap-4 border-b px-[18px] py-2.5 md:grid',
        AGENCY_ROW_GRID
      )}
    >
      <span className={cell}>Project</span>
      <span className={cell}>Delivered by</span>
      <span className={cell}>Status</span>
      <span className={cn(cell, 'text-right')}>Updated</span>
      <span />
    </div>
  );
}

interface FinishedGroupProps {
  rows: AgencyRowView[];
  agencyName: string;
  fromFilter: AgencyFilter;
}

/** Completed and cancelled: purely retrospective, so it renders nothing when empty. */
function FinishedGroup({
  rows,
  agencyName,
  fromFilter,
}: Readonly<FinishedGroupProps>): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <Collapsible>
      <BaloCard className="overflow-hidden">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring group flex w-full items-center gap-2 px-4 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset motion-reduce:transition-none"
          >
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
            <SectionLabel>Completed and cancelled</SectionLabel>
            <Badge variant="secondary">{rows.length}</Badge>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-border/60 border-t">
            {rows.map((row, index) => (
              <AgencyRow
                key={row.id}
                row={row}
                agencyName={agencyName}
                fromFilter={fromFilter}
                last={index === rows.length - 1}
                finished
              />
            ))}
          </div>
        </CollapsibleContent>
      </BaloCard>
    </Collapsible>
  );
}

function NoMatch({ onReset }: Readonly<{ onReset: () => void }>): React.JSX.Element {
  return (
    <BaloCard className="px-5 py-8 text-center">
      <p className="text-foreground text-sm font-semibold">No live projects match these filters.</p>
      <Button type="button" variant="ghost" size="sm" className="mt-3" onClick={onReset}>
        Show all
      </Button>
    </BaloCard>
  );
}

/** A finished-only agency: nothing live, and no filter to blame. An invitation, not a dead end. */
function NothingLive({ agencyName }: Readonly<{ agencyName: string }>): React.JSX.Element {
  return (
    <BaloCard className="px-5 py-8 text-center">
      <p className="text-muted-foreground text-sm">
        Nothing is in delivery right now — new projects with {agencyName} experts will show up here.
      </p>
    </BaloCard>
  );
}

function derivePeople(
  all: ReadonlyArray<AgencyRowView>,
  byTile: ReadonlyArray<AgencyRowView>
): AgencyPerson[] {
  const seen = new Map<string, AgencyPerson>();
  for (const row of all) {
    const { deliverer } = row;
    if (seen.has(deliverer.expertProfileId)) continue;
    seen.set(deliverer.expertProfileId, {
      expertProfileId: deliverer.expertProfileId,
      label: deliverer.isViewer ? 'You' : deliverer.name,
      isViewer: deliverer.isViewer,
      count: byTile.filter((r) => r.deliverer.expertProfileId === deliverer.expertProfileId).length,
    });
  }
  return [...seen.values()].sort(
    (a, b) => Number(b.isViewer) - Number(a.isViewer) || a.label.localeCompare(b.label)
  );
}

export function AgencyDash({ dto }: Readonly<AgencyDashProps>): React.JSX.Element {
  const [tile, setTile] = useState<AgencyFilter>('all');
  const [who, setWho] = useState<string>(EVERYONE);

  const byTile = useMemo(() => dto.rows.filter((r) => agencyRowMatches(r, tile)), [dto.rows, tile]);
  const matchesWho = useCallback(
    (row: AgencyRowView) => who === EVERYONE || row.deliverer.expertProfileId === who,
    [who]
  );
  const rows = useMemo(() => byTile.filter(matchesWho), [byTile, matchesWho]);
  const finished = useMemo(
    () => dto.finishedRows.filter(matchesWho),
    [dto.finishedRows, matchesWho]
  );
  const people = useMemo(
    () => derivePeople([...dto.rows, ...dto.finishedRows], byTile),
    [dto.rows, dto.finishedRows, byTile]
  );

  const handleTile = useCallback(
    (key: string) => {
      const next: AgencyFilter = tile === key ? 'all' : (key as AgencyFilter);
      setTile(next);
      track(PROJECTS_INBOX_EVENTS.INBOX_FILTER_APPLIED, {
        lens: 'agency',
        filter: next,
        result_count: dto.rows.filter((r) => agencyRowMatches(r, next) && matchesWho(r)).length,
      });
    },
    [tile, dto.rows, matchesWho]
  );

  const handlePerson = useCallback(
    (id: string) => {
      setWho(id);
      track(PROJECTS_INBOX_EVENTS.INBOX_EXPERT_FILTER_APPLIED, {
        lens: 'agency',
        is_self: people.some((p) => p.isViewer && p.expertProfileId === id),
        result_count: byTile.filter((r) => id === EVERYONE || r.deliverer.expertProfileId === id)
          .length,
      });
    },
    [people, byTile]
  );

  const handleReset = useCallback(() => {
    setTile('all');
    setWho(EVERYONE);
  }, []);

  const filtersActive = tile !== 'all' || who !== EVERYONE;
  const reduceMotion = useReducedMotion();
  const { tiles: counts } = dto;
  const expertLabel = counts.expertCount === 1 ? 'expert' : 'experts';
  const tileDescriptors: StatTileDescriptor[] = [
    {
      key: 'changes_requested',
      label: 'Changes requested',
      count: counts.changesRequested,
      icon: AlertCircle,
      tone: 'text-warning',
      emphasize: counts.changesRequested > 0,
      sub: "Your agency's move",
    },
    {
      key: 'in_delivery',
      label: 'In delivery',
      count: counts.inDelivery,
      icon: Activity,
      tone: 'text-primary',
      sub: 'Work underway',
    },
    {
      key: 'pending_acceptance',
      label: 'Awaiting review',
      count: counts.pendingAcceptance,
      icon: Clock,
      tone: 'text-info',
      sub: 'With the client',
    },
    {
      key: 'all',
      label: 'Live',
      count: counts.live,
      icon: Briefcase,
      tone: 'text-muted-foreground',
      sub: `Across ${counts.expertCount} ${expertLabel}`,
    },
  ];

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="flex flex-col gap-5"
    >
      {dto.agencies.length >= 2 && (
        <AgencyPicker agencies={dto.agencies} selectedId={dto.agency.id} />
      )}

      {dto.isEmpty ? (
        <AgencyEmptyState agencyName={dto.agency.name} />
      ) : (
        <>
          <StatTiles tiles={tileDescriptors} active={tile} onSelect={handleTile} />

          <section aria-label={LIST_LABEL[tile]}>
            <div className="mb-2.5 flex flex-col gap-2.5 md:flex-row md:flex-wrap md:items-center md:justify-between">
              <div className="flex items-center gap-2">
                <SectionLabel>{LIST_LABEL[tile]}</SectionLabel>
                <Badge variant="secondary">{rows.length}</Badge>
              </div>
              <AgencyPersonFilter
                people={people}
                active={who}
                total={byTile.length}
                onPick={handlePerson}
              />
            </div>

            {rows.length > 0 ? (
              <BaloCard className="overflow-hidden">
                <ListHeader />
                {rows.map((row, index) => (
                  <AgencyRow
                    key={row.id}
                    row={row}
                    agencyName={dto.agency.name}
                    fromFilter={tile}
                    last={index === rows.length - 1}
                  />
                ))}
              </BaloCard>
            ) : filtersActive ? (
              <NoMatch onReset={handleReset} />
            ) : (
              <NothingLive agencyName={dto.agency.name} />
            )}
          </section>

          <FinishedGroup rows={finished} agencyName={dto.agency.name} fromFilter={tile} />
        </>
      )}
    </motion.div>
  );
}
