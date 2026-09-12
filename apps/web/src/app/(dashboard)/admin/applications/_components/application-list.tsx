import Link from 'next/link';
import { ChevronRight, UserPlus, CheckCheck } from 'lucide-react';
import type { ApplicationReviewFilter } from '@balo/db';
import { LocalDate } from '@/components/local-date';
import { ApplicationFilterChips } from './application-filter-chips';
import type { ApplicationListRowView } from '../_lib/application-list-view';

/**
 * BAL-549 — the `/admin/applications` list: chips + rows + the two empty states.
 *
 * Pure over already-resolved props — `load-applications.ts` / `page.tsx` do the fetching and
 * the row-view mapping (so `now` is computed exactly once, server-side, avoiding a
 * hydration-mismatch date). `loading.tsx` / `error.tsx` are the route-segment boundaries for
 * the other two async states.
 *
 * ⚠ A SERVER COMPONENT (fix round, F16). It has no hooks and no handlers — only `Link`s, the
 * empty states and the chips child — so it carries no `'use client'`. `ApplicationFilterChips`
 * is the ONE client leaf on this surface (it needs `useRouter`), which is where the boundary
 * belongs. Server Components by default.
 */

interface ApplicationListProps {
  readonly filter: ApplicationReviewFilter;
  readonly rows: readonly ApplicationListRowView[];
  readonly counts: Record<ApplicationReviewFilter, number>;
  readonly truncated: boolean;
}

function PendingEmpty(): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-2xl border py-16 text-center">
      <div className="from-primary/10 mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br to-transparent">
        <UserPlus className="text-primary size-6" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">Nothing waiting</h3>
      <p className="text-muted-foreground mx-auto mt-1.5 max-w-md text-sm leading-relaxed">
        {/* pending-MJ — invitation-framed, per CLAUDE.md's empty-state rule */}
        New applications land here the moment an expert submits.
      </p>
    </div>
  );
}

/**
 * ⚠ THE DECIDED ARM NEEDS A WAY OUT (fix round, F17). `ApplicationFilterChips` `disabled`s every
 * zero-count chip that is not the active one, so on `?filter=declined` with all counts at 0 this
 * empty state was the whole surface and offered no route back to Pending. The link below is that
 * route — the `QueueFilteredEmpty` clear-the-filter precedent.
 */
function DecidedEmpty(): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-2xl border py-16 text-center">
      <div className="bg-success/10 mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl">
        <CheckCheck className="text-success size-6" aria-hidden="true" />
      </div>
      {/* pending-MJ — retrospective data, softened per the `QueueFilteredEmpty` precedent (F7) */}
      <h3 className="text-foreground text-lg font-semibold">Nothing decided in the last 30 days</h3>
      <p className="text-muted-foreground mx-auto mt-1.5 max-w-md text-sm leading-relaxed">
        {/* pending-MJ */}
        Decided applications from the last month show up in this list.
      </p>
      <Link
        href="/admin/applications?filter=pending"
        className="text-primary focus-visible:ring-ring mt-4 inline-flex min-h-[44px] items-center rounded-lg text-sm font-semibold hover:underline focus-visible:ring-2 focus-visible:outline-none"
      >
        {/* pending-MJ */}
        Show pending applications
      </Link>
    </div>
  );
}

/** Extracted so the empty-state choice is a plain if/else, not a nested ternary. */
function renderEmptyState(filter: ApplicationReviewFilter): React.JSX.Element {
  if (filter === 'pending') return <PendingEmpty />;
  return <DecidedEmpty />;
}

export function ApplicationList({
  filter,
  rows,
  counts,
  truncated,
}: Readonly<ApplicationListProps>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <ApplicationFilterChips filter={filter} counts={counts} />

      {rows.length === 0 ? (
        renderEmptyState(filter)
      ) : (
        <div className="border-border bg-card divide-border divide-y rounded-2xl border">
          {rows.map((row) => (
            <Link
              key={row.expertProfileId}
              href={`/admin/applications/${row.expertProfileId}`}
              className="focus-visible:ring-ring hover:bg-muted flex min-h-[44px] items-center gap-3 p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-foreground text-sm font-semibold">{row.name}</p>
                  <span className="text-muted-foreground text-xs">{row.agencyLabel}</span>
                </div>
                <p className="text-muted-foreground mt-0.5 text-[13px] leading-relaxed">
                  {row.email}
                </p>
              </div>
              <span className="text-muted-foreground shrink-0 text-xs font-medium whitespace-nowrap">
                {row.statusLine}
                {/* W4 — the decision DATE in the viewer's zone; see `formatDecisionAttribution`. */}
                {row.decidedAtIso !== null && (
                  <>
                    {' · '}
                    <LocalDate iso={row.decidedAtIso} />
                  </>
                )}
              </span>
              <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            </Link>
          ))}
        </div>
      )}

      {truncated && (
        <p className="text-muted-foreground text-center text-xs">
          {/*
            pending-MJ — fix round F19. The three filters are DISJOINT, so "narrow the filter to
            see more" named an action that reveals nothing. Each arm now says what the batch
            actually is: pending is OLDEST-first, so working the queue uncovers the rest;
            decided is NEWEST-first within a 30-day window, so there is simply an older tail.
          */}
          {filter === 'pending'
            ? `Showing the oldest ${rows.length} — decide some to see the rest.`
            : `Showing the ${rows.length} most recent — older decisions are not listed.`}
        </p>
      )}
    </div>
  );
}
