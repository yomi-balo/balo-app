import Link from 'next/link';
import { ChevronRight, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CatalogueTone, ResolvedCatalogueRow } from '../_lib/admin-catalogue';

/**
 * BAL-534 — the admin catalogue list. Pure presentational Server Component over
 * already-resolved rows: no `'use client'`, no state, no data fetching.
 *
 * `ADMIN_CATALOGUE_ROWS` is a non-empty compile-time constant, so there is no empty-list state
 * to design here — shipping one would be unreachable UI.
 */

const TONE_CLASSNAMES: Record<CatalogueTone, string> = {
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  neutral: 'bg-muted text-muted-foreground',
};

function StatusChip({
  status,
  tone,
}: Readonly<{ status: string; tone: CatalogueTone }>): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        TONE_CLASSNAMES[tone]
      )}
    >
      {status}
    </span>
  );
}

function RowBody({ row }: Readonly<{ row: ResolvedCatalogueRow }>): React.JSX.Element {
  const Icon = row.icon;
  return (
    <>
      <div className="bg-muted flex size-[30px] shrink-0 items-center justify-center rounded-lg">
        <Icon className="text-muted-foreground size-3.5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-foreground text-sm font-semibold">{row.title}</p>
          {row.isViewOnly && (
            <span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
              <Lock className="size-3" aria-hidden="true" />
              View only
              <span className="sr-only">You can open this surface but not change it</span>
            </span>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 text-[13px] leading-relaxed">
          {row.description}
        </p>
      </div>
      <StatusChip status={row.status} tone={row.tone} />
      {row.linkHref !== null && (
        <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      )}
    </>
  );
}

interface CatalogueListProps {
  readonly rows: readonly ResolvedCatalogueRow[];
}

export function CatalogueList({ rows }: Readonly<CatalogueListProps>): React.JSX.Element {
  return (
    <div className="border-border bg-card divide-border divide-y rounded-2xl border">
      {rows.map((row) =>
        row.linkHref === null ? (
          <div
            key={row.key}
            data-testid="catalogue-row-inert"
            className="flex min-h-[44px] items-center gap-3 p-4"
          >
            <RowBody row={row} />
          </div>
        ) : (
          <Link
            key={row.key}
            href={row.linkHref}
            className="focus-visible:ring-ring hover:bg-muted flex min-h-[44px] items-center gap-3 p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <RowBody row={row} />
          </Link>
        )
      )}
    </div>
  );
}
