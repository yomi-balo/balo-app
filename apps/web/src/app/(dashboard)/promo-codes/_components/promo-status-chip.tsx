import { cn } from '@/lib/utils';
import type { PromoDisplayStatus } from '@/lib/promo-codes/promo-codes-view';

/**
 * PromoStatusChip — the DERIVED display-status pill for a promo-code row. Pure +
 * server-safe (no interactivity). Data-driven status → label + CSS-variable tone (never
 * hex): active → success (live/redeemable), scheduled → info, exhausted → warning,
 * expired → muted, deactivated → destructive. Dark-aware via the token classes.
 */

interface PromoStatusChipProps {
  status: PromoDisplayStatus;
}

const STATUS_META: Record<PromoDisplayStatus, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'bg-success/15 text-success' },
  scheduled: { label: 'Scheduled', tone: 'bg-info/15 text-info' },
  exhausted: { label: 'Exhausted', tone: 'bg-warning/15 text-warning' },
  expired: { label: 'Expired', tone: 'bg-muted text-muted-foreground' },
  deactivated: { label: 'Deactivated', tone: 'bg-destructive/10 text-destructive' },
};

export function PromoStatusChip({ status }: Readonly<PromoStatusChipProps>): React.JSX.Element {
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
