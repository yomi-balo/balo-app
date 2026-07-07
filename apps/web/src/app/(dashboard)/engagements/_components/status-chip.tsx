import { cn } from '@/lib/utils';
import type { EngagementOversightRow } from '@/lib/engagements/oversight-row';

/**
 * StatusChip — the engagement-status pill for an oversight row. Pure +
 * server-safe (no interactivity). Data-driven status → label + CSS-variable tone
 * (never hex): active → primary, in review → warning, completed → success,
 * cancelled → muted. Dark-aware via the token classes.
 */

type OversightStatus = EngagementOversightRow['status'];

interface StatusChipProps {
  status: OversightStatus;
}

const STATUS_META: Record<OversightStatus, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'bg-primary/10 text-primary' },
  pending_acceptance: { label: 'In review', tone: 'bg-warning/15 text-warning' },
  completed: { label: 'Completed', tone: 'bg-success/15 text-success' },
  cancelled: { label: 'Cancelled', tone: 'bg-muted text-muted-foreground' },
};

export function StatusChip({ status }: Readonly<StatusChipProps>): React.JSX.Element {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        meta.tone
      )}
    >
      {meta.label}
    </span>
  );
}
