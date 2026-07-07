'use client';

import Link from 'next/link';
import { AlertCircle, ArrowRight, Briefcase, Clock, Zap } from 'lucide-react';
import type { AdminPortfolioDTO } from '@/lib/projects-inbox/portfolio-row';
import { StatTiles, type StatTileDescriptor } from './stat-tiles';
import { AdminTriageCard } from './admin-triage-card';
import { PipelineKanban } from './pipeline-kanban';

/**
 * AdminDash — the admin dashboard body (the design's `AdminDash`): read-only
 * stat tiles + a warning "Needs triage" hero of `requested` cards + the pipeline
 * mini-kanban. The tiles are non-interactive (admins monitor; no per-tile filter
 * in the design), so `StatTiles` renders with `active=null` and no `onSelect`.
 */

interface AdminDashProps {
  dto: AdminPortfolioDTO;
}

export function AdminDash({ dto }: Readonly<AdminDashProps>): React.JSX.Element {
  const tiles: StatTileDescriptor[] = [
    {
      key: 'untriaged',
      label: 'Untriaged',
      count: dto.tiles.untriaged,
      icon: Zap,
      tone: 'text-warning',
      emphasize: true,
      sub: 'Awaiting triage',
    },
    {
      key: 'stalled',
      label: 'Stalled',
      count: dto.tiles.stalled,
      icon: AlertCircle,
      tone: 'text-destructive',
      emphasize: true,
      sub: 'Need a chase',
    },
    {
      key: 'pipeline',
      label: 'In pipeline',
      count: dto.tiles.pipeline,
      icon: Briefcase,
      tone: 'text-muted-foreground',
      sub: 'Active requests',
    },
    {
      key: 'gate',
      label: 'Kickoff gate',
      count: dto.tiles.gate,
      icon: Clock,
      tone: 'text-success',
      sub: 'Awaiting confirmation',
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <StatTiles tiles={tiles} active={null} />

      {dto.triage.length > 0 && (
        <section aria-label="Needs triage">
          <div className="mb-2.5 flex items-center gap-2">
            <Zap className="text-warning h-4 w-4" aria-hidden="true" />
            <span className="text-warning text-xs font-bold tracking-wider uppercase">
              Needs triage
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {dto.triage.map((card, index) => (
              <AdminTriageCard key={card.id} card={card} index={index} />
            ))}
          </div>
        </section>
      )}

      <section aria-label="Pipeline by stage">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Briefcase className="text-muted-foreground h-4 w-4" aria-hidden="true" />
            <span className="text-muted-foreground text-xs font-bold tracking-wider uppercase">
              Pipeline by stage
            </span>
          </div>
          {/* Cross-link to the delivery oversight list — the pipeline ends at
              kickoff; the engagements list begins there ("after the board"). */}
          <Link
            href="/engagements"
            className="text-primary focus-visible:ring-ring inline-flex shrink-0 items-center gap-1 rounded text-xs font-semibold hover:underline focus-visible:ring-2 focus-visible:outline-none"
          >
            Delivery oversight
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
        <PipelineKanban columns={dto.kanban} />
      </section>
    </div>
  );
}
