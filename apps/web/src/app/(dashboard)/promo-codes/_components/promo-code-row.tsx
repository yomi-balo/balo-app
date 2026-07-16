'use client';

import { Ban, Eye, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LocalDate } from '@/components/local-date';
import type { PromoCodeAdminRow } from '@/lib/promo-codes/promo-codes-view';
import { PromoStatusChip } from './promo-status-chip';

/**
 * PromoCodeRow — one row of the admin promo-code list. Presentational (props + callbacks
 * the shell owns): the code (mono), the grant per redemption, the cap usage as
 * `redeemed of cap` with a Progress meter + remaining, the validity window (viewer-local
 * dates), the derived status chip, and per-row actions (View redemptions / Edit cap /
 * Deactivate). Deactivate hides once a code is already deactivated.
 */

interface PromoCodeRowProps {
  row: PromoCodeAdminRow;
  selected: boolean;
  last: boolean;
  onView: (id: string) => void;
  onEditCap: (row: PromoCodeAdminRow) => void;
  onDeactivate: (row: PromoCodeAdminRow) => void;
}

/** Compact cap-usage meter: "{redeemed} of {cap}" + a thin fill + "{remaining} left". */
function CapMeter({
  redeemed,
  cap,
  remaining,
  usedPct,
}: Readonly<{
  redeemed: number;
  cap: number;
  remaining: number;
  usedPct: number;
}>): React.JSX.Element {
  const exhausted = remaining === 0;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-muted-foreground text-xs font-semibold tabular-nums">
        {redeemed} of {cap} redeemed
      </span>
      <span className="bg-muted inline-block h-1.5 w-16 overflow-hidden rounded-full">
        <span
          className={cn('block h-full rounded-full', exhausted ? 'bg-warning' : 'bg-primary')}
          style={{ width: `${usedPct}%` }}
        />
      </span>
      <span className="text-muted-foreground text-xs tabular-nums">{remaining} left</span>
    </span>
  );
}

export function PromoCodeRow({
  row,
  selected,
  last,
  onView,
  onEditCap,
  onDeactivate,
}: Readonly<PromoCodeRowProps>): React.JSX.Element {
  const canDeactivate = row.displayStatus !== 'deactivated';
  return (
    <div
      className={cn(
        'flex w-full flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:gap-3',
        selected && 'bg-muted/40',
        !last && 'border-border border-b'
      )}
    >
      <div className="min-w-0 flex-1">
        {/* Line 1 — code + derived status */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-foreground font-mono text-sm font-semibold tracking-wide">
            {row.code}
          </span>
          <PromoStatusChip status={row.displayStatus} />
        </div>

        {/* Line 2 — grant per redemption */}
        <p className="text-muted-foreground mt-1.5 text-xs">
          Grants{' '}
          <span className="text-foreground font-semibold tabular-nums">{row.grantLabel}</span> per
          redemption
        </p>

        {/* Line 3 — cap usage */}
        <div className="mt-2">
          <CapMeter
            redeemed={row.redeemedCount}
            cap={row.perCodeRedemptionCap}
            remaining={row.remaining}
            usedPct={row.usedPct}
          />
        </div>

        {/* Line 4 — validity window */}
        <p className="text-muted-foreground mt-2 text-xs">
          Valid <LocalDate iso={row.validFromIso} /> – <LocalDate iso={row.validUntilIso} />
        </p>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onView(row.id)}
          aria-pressed={selected}
          className={cn(
            'focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none',
            selected
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:bg-muted'
          )}
        >
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          {selected ? 'Hide' : 'View'} redemptions
        </button>
        <button
          type="button"
          onClick={() => onEditCap(row)}
          className="border-border text-muted-foreground hover:bg-muted focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          Edit cap
        </button>
        {canDeactivate && (
          <button
            type="button"
            onClick={() => onDeactivate(row)}
            className="text-destructive hover:bg-destructive/10 focus-visible:ring-destructive/40 inline-flex items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <Ban className="h-3.5 w-3.5" aria-hidden="true" />
            Deactivate
          </button>
        )}
      </div>
    </div>
  );
}
