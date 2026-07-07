import { AlertTriangle } from 'lucide-react';

/**
 * StalledChip — the destructive "gone quiet" flag on an oversight row, modelled
 * on the pipeline kanban's stalled pill (`bg-destructive/10 text-destructive` +
 * icon). Shows the whole-day quiet span. Pure + server-safe.
 */

interface StalledChipProps {
  days: number;
}

export function StalledChip({ days }: Readonly<StalledChipProps>): React.JSX.Element {
  return (
    <span className="bg-destructive/10 text-destructive inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap">
      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
      Quiet {days}d
    </span>
  );
}
