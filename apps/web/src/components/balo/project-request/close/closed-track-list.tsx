import { XCircle } from 'lucide-react';
import { RequestCard } from '../request-card';
import type { ClosedTrackView } from '@/lib/project-request/request-detail-view';

/**
 * ClosedTrackList — BAL-540 Phase 6.3 (design ref `TrackCard`'s frozen/`dim` state,
 * `:476-571`). Renders every relationship's frozen final state on a closed request, for the
 * client + admin lenses only (`RequestDetailView.closedTracks` is always `[]` for the expert
 * lens and for a live request). No EOI HTML, no money, no contact — a purely historical list.
 *
 * Empty (`tracks.length === 0`, a request closed with nobody ever invited) renders NOTHING —
 * the CLAUDE.md exception for purely retrospective data the viewer cannot act on: there is no
 * invitation to make on a closed request, so there is no invitation-shaped empty state to draw.
 */

const CHIP_LABEL: Record<ClosedTrackView['finalChip'], string> = {
  invite_withdrawn: 'Invite withdrawn', // pending-MJ
  declined: 'Declined', // pending-MJ
  ended_request_closed: 'Ended — request closed', // pending-MJ
};

interface ClosedTrackListProps {
  tracks: readonly ClosedTrackView[];
}

export function ClosedTrackList({
  tracks,
}: Readonly<ClosedTrackListProps>): React.JSX.Element | null {
  if (tracks.length === 0) return null;

  return (
    <div className="flex flex-col gap-2.5">
      {/* pending-MJ */}
      <p className="text-muted-foreground text-xs font-bold tracking-wider uppercase">
        Experts · {tracks.length}
      </p>
      {tracks.map((track) => (
        <RequestCard key={track.relationshipId} className="p-3.5 opacity-60">
          <div className="flex items-center gap-3">
            <span className="bg-muted text-muted-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold">
              {track.expertInitials}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-foreground text-sm font-semibold">{track.expertName}</span>
                <span className="border-border bg-card text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold">
                  <XCircle className="h-2.5 w-2.5" aria-hidden="true" />
                  {CHIP_LABEL[track.finalChip]}
                </span>
              </div>
              <p className="text-muted-foreground mt-0.5 text-[12.5px]">{track.endedLabel}</p>
            </div>
          </div>
        </RequestCard>
      ))}
    </div>
  );
}
