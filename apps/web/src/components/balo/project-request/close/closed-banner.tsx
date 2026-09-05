import Link from 'next/link';
import { Lock, Plus, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RequestCard } from '../request-card';
import { formatLongUtc } from '@/lib/format/utc-date';
import { REASON_LABEL } from '@/lib/project-request/close-copy';
import type { ClosedRequestSummary } from '@/lib/project-request/request-detail-view';

/**
 * ClosedBanner — BAL-540 Phase 6.3 (design ref `ClosedBanner`, `:882-960`). Replaces the
 * status stepper + nudge bar once a request is closed. Retrospective copy (CLAUDE.md): names
 * the person "@ company/Balo" on first mention. The Balo-only note renders ONLY when
 * `closed.note !== null` — D11's negative assertion lives in this component's test, alongside
 * `closed-request-view.test.ts`'s pure-derivation negative.
 *
 * Server Component — no interactivity of its own beyond the plain `<Link>` to `/projects/new`.
 */

interface ClosedBannerProps {
  closed: ClosedRequestSummary;
  /** Only client/admin ever reach this component — an expert's closed view is `ExpertEndedTrackView`. */
  viewerLens: 'client' | 'admin';
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function ClosedBanner({
  closed,
  viewerLens,
}: Readonly<ClosedBannerProps>): React.JSX.Element {
  const dateLabel = formatLongUtc(new Date(closed.closedAtIso));
  const verb = closed.reason === 'withdrawn' ? 'Withdrawn' : 'Closed'; // pending-MJ

  return (
    <RequestCard className="border-border bg-muted/40 p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="border-border bg-card flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border">
          <XCircle className="text-muted-foreground h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          {/* pending-MJ */}
          <p className="text-foreground text-[15px] font-semibold">
            Closed on {dateLabel} · {REASON_LABEL[closed.reason]}
          </p>
          {/* pending-MJ */}
          <p className="text-muted-foreground mt-1 text-[12.5px]">
            {verb} by {closed.closedByLabel} · {pluralize(closed.counts.tracksEnded, 'track')} ended
            · {pluralize(closed.counts.meetingsCancelled, 'meeting')} cancelled · files unchanged
          </p>
          {closed.note !== null && (
            <p className="border-border bg-card text-foreground mt-2.5 flex items-start gap-2 rounded-lg border border-dashed px-2.5 py-2 text-[12.5px]">
              <Lock className="text-muted-foreground mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span>
                {/* pending-MJ */}
                <span className="text-muted-foreground font-semibold">Balo only · </span>
                {closed.note}
              </span>
            </p>
          )}
        </div>
        {viewerLens === 'client' && (
          <Button asChild>
            <Link href="/projects/new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              {/* pending-MJ */}
              Raise a new request
            </Link>
          </Button>
        )}
      </div>
    </RequestCard>
  );
}
