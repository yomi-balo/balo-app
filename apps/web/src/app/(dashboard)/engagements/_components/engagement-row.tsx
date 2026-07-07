import Link from 'next/link';
import { Building2, ChevronRight, Clock, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EngagementOversightRow } from '@/lib/engagements/oversight-row';
import { LocalDate } from '@/components/local-date';
import { StatusChip } from './status-chip';
import { StalledChip } from './stalled-chip';

/**
 * EngagementRow — one row of the admin oversight list (the design's
 * `EngagementRow`). Presentational `<Link>` to the engagement admin lens. Four
 * lines: title + inline stalled flag · parties (client company + expert) ·
 * progress · pricing · kickoff · a status-specific FACT line (money about to
 * move / who accepted / why cancelled / gone quiet). Right rail carries the
 * status chip, last-activity (desktop), and a chevron. Absolute dates render in
 * the viewer's own timezone via `<LocalDate>`; the shell owns filter state.
 */

interface EngagementRowProps {
  row: EngagementOversightRow;
  last: boolean;
}

/** Compact N-of-M milestone meter; "No milestones" when the engagement has none. */
function ProgressMeter({
  done,
  total,
}: Readonly<{ done: number; total: number }>): React.JSX.Element {
  if (total === 0) {
    return <span className="text-muted-foreground text-xs">No milestones</span>;
  }
  const pct = Math.round((done / total) * 100);
  const complete = done === total;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-muted-foreground text-xs font-semibold tabular-nums">
        {done} of {total}
      </span>
      <span className="bg-muted inline-block h-1.5 w-11 overflow-hidden rounded-full">
        <span
          className={cn('block h-full rounded-full', complete ? 'bg-success' : 'bg-primary')}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}

/**
 * The status-specific fact line. Early-returns per status (no nested ternary):
 * in-review states the auto-accept date as a helpful fact (never a countdown);
 * completed/cancelled carry retrospective attribution; a stalled active row
 * states the quiet span. Returns null when there is no fact to add.
 */
function FactLine({ row }: Readonly<{ row: EngagementOversightRow }>): React.JSX.Element | null {
  if (row.status === 'pending_acceptance') {
    if (row.autoAcceptIso === undefined) return null;
    return (
      <p className="mt-2 text-xs leading-relaxed">
        <span className="text-warning font-semibold">
          Auto-accepts <LocalDate iso={row.autoAcceptIso} />
        </span>
        <span className="text-muted-foreground">
          {' '}
          — {row.client} can accept or request changes until then
        </span>
      </p>
    );
  }
  if (row.status === 'completed' && row.acceptance !== undefined) {
    const { byLabel, onIso } = row.acceptance;
    const lead = byLabel !== null ? `Accepted by ${byLabel}` : 'Auto-accepted';
    const separator = byLabel !== null ? ' · ' : ' ';
    return (
      <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
        {lead}
        {onIso !== null && (
          <>
            {separator}
            <LocalDate iso={onIso} />
          </>
        )}
      </p>
    );
  }
  if (row.status === 'cancelled' && row.cancellation !== undefined) {
    const { byLabel, onIso, reason } = row.cancellation;
    const who = byLabel ?? 'an admin';
    const suffix = reason.trim().length > 0 ? ` — ${reason}` : '';
    return (
      <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
        Cancelled by {who}
        {onIso !== null && (
          <>
            {' · '}
            <LocalDate iso={onIso} />
          </>
        )}
        {suffix}
      </p>
    );
  }
  if (row.stalled) {
    return (
      <p className="text-destructive mt-2 text-xs leading-relaxed font-semibold">
        No milestone activity in {row.quietDays} days
      </p>
    );
  }
  return null;
}

export function EngagementRow({ row, last }: Readonly<EngagementRowProps>): React.JSX.Element {
  return (
    <Link
      href={row.href}
      className={cn(
        'focus-visible:ring-ring hover:bg-muted/60 flex w-full items-start gap-3 px-4 py-4 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none',
        !last && 'border-border border-b'
      )}
    >
      <div className="min-w-0 flex-1">
        {/* Line 1 — title + inline stalled flag */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="text-foreground text-sm font-semibold whitespace-normal sm:truncate">
            {row.title}
          </p>
          {row.stalled && <StalledChip days={row.quietDays} />}
        </div>

        {/* Line 2 — parties: client company + expert person (@ agency) */}
        <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1">
            <Building2 className="h-3 w-3" aria-hidden="true" />
            <span className="font-medium">{row.client}</span>
          </span>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            <User className="h-3 w-3" aria-hidden="true" />
            <span>{row.expertLabel}</span>
          </span>
        </div>

        {/* Line 3 — progress · pricing · kickoff */}
        <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
          <ProgressMeter done={row.progress.done} total={row.progress.total} />
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{row.pricingLabel}</span>
          <span aria-hidden="true">·</span>
          <span>
            Kicked off <LocalDate iso={row.kickoffIso} />
          </span>
        </div>

        {/* Line 4 — status-specific fact */}
        <FactLine row={row} />
      </div>

      {/* Right rail — status chip + last activity + chevron */}
      <div className="flex shrink-0 flex-col items-end gap-2">
        <StatusChip status={row.status} />
        <span className="text-muted-foreground hidden items-center gap-1 text-xs whitespace-nowrap sm:inline-flex">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {row.lastActivityRelative}
        </span>
      </div>
      <ChevronRight className="text-muted-foreground mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
    </Link>
  );
}
