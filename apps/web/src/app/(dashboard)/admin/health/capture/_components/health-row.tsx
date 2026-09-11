import { RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { LadderChip } from './ladder-chip';
import type { CaptureHealthRowView } from '../_lib/capture-health-view';

/**
 * BAL-550 — one capture-health row (design reference `HealthRow`, `admin-home.jsx:1900`). PURE
 * — no hooks, no client state — so both the server-rendered pinned band and the client
 * `HealthList` can render it identically. The re-drive BUTTON is the only interactive surface,
 * and it is a plain `onClick` prop, never a Server Action call of its own (`HealthList`/
 * `RedriveSheet` own that).
 */
interface HealthRowProps {
  readonly row: CaptureHealthRowView;
  readonly index: number;
  readonly last: boolean;
  readonly highlighted?: boolean;
  readonly canRedrive: boolean;
  readonly onRedrive: (row: CaptureHealthRowView) => void;
}

export function HealthRow({
  row,
  index,
  last,
  highlighted = false,
  canRedrive,
  onRedrive,
}: Readonly<HealthRowProps>): React.JSX.Element {
  const action = row.action;

  return (
    <div
      data-testid={`health-row-${row.meetingId}`}
      className={cn(
        'animate-in fade-in grid items-start gap-4 p-4 motion-reduce:animate-none md:grid-cols-[1.15fr_2fr_auto]',
        !last && 'border-border border-b',
        highlighted && 'bg-primary/5 shadow-[inset_3px_0_0_var(--primary)]'
      )}
      style={{ animationDelay: `${60 + index * 30}ms` }}
    >
      <div className="min-w-0">
        <p className="text-foreground text-sm font-bold">{row.title}</p>
        <p className="text-muted-foreground mt-1 text-[12.5px]">{row.parties}</p>
        <p className="text-muted-foreground mt-1 text-[11.5px] tabular-nums">
          {row.when} · {row.durationLabel} · {row.contextLabel}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <div>
          <p className="text-muted-foreground mb-1 text-[10.5px] font-bold tracking-wide uppercase">
            Recording
          </p>
          <LadderChip ladder="rec" state={row.recording} />
        </div>
        <div>
          <p className="text-muted-foreground mb-1 text-[10.5px] font-bold tracking-wide uppercase">
            Transcription
          </p>
          <LadderChip ladder="tx" state={row.transcription} />
        </div>
        <div>
          <p className="text-muted-foreground mb-1 text-[10.5px] font-bold tracking-wide uppercase">
            Recap
          </p>
          <LadderChip ladder="recap" state={row.recap} />
        </div>
      </div>

      <div className="min-w-0 md:w-[150px]">
        {action.kind === 'recording-ingest' && (
          <div className="flex flex-col items-start gap-1 md:items-end">
            <Button
              size="sm"
              disabled={!canRedrive}
              title={canRedrive ? action.segmentLabel : 'Re-drive needs an engineer (REDRIVE_JOB)'}
              onClick={() => onRedrive(row)}
            >
              <RotateCw className="size-3.5" aria-hidden="true" />
              Re-drive ingest
            </Button>
            {!canRedrive && (
              <span className="text-muted-foreground text-[11px]">Needs an engineer</span>
            )}
          </div>
        )}
        {action.kind === 'transcript-pipeline' && (
          <div className="flex flex-col items-start gap-1 md:items-end">
            <Button
              size="sm"
              disabled={!canRedrive}
              title={canRedrive ? undefined : 'Re-drive needs an engineer (REDRIVE_JOB)'}
              onClick={() => onRedrive(row)}
            >
              <RotateCw className="size-3.5" aria-hidden="true" />
              Re-run recap
            </Button>
            {!canRedrive && (
              <span className="text-muted-foreground text-[11px]">Needs an engineer</span>
            )}
          </div>
        )}
        {action.kind === 'note' && (
          <p className="text-muted-foreground max-w-[220px] text-[11.5px] leading-relaxed md:text-right">
            {action.note}
          </p>
        )}
      </div>
    </div>
  );
}
