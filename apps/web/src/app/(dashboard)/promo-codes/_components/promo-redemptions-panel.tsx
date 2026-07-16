'use client';

import { Building2, Clock, User, Wallet, X } from 'lucide-react';
import { LocalDate } from '@/components/local-date';
import type { PromoCodeAdminRow } from '@/lib/promo-codes/promo-codes-view';

/**
 * PromoRedemptionsPanel — the read-only redemption tracking view for the selected code.
 * Header states the remaining cap ("Remaining: {remaining} of {cap}"). Body lists who
 * redeemed (company party + individual actor), when, and the snapshotted grant.
 *
 * This is the exact path that reads the empty-until-BAL-383 `promo_redemptions` table
 * (AC-2): an unredeemed code shows an INFORMATIVE state ("No redemptions yet", "All
 * {cap} redemptions are still available.") — pairing the zero with the remaining cap
 * keeps it useful rather than a bare "None yet" (balo-ui empty-state rule).
 */

interface PromoRedemptionsPanelProps {
  row: PromoCodeAdminRow;
  onClose: () => void;
}

export function PromoRedemptionsPanel({
  row,
  onClose,
}: Readonly<PromoRedemptionsPanelProps>): React.JSX.Element {
  const hasRedemptions = row.redemptions.length > 0;
  return (
    <section
      aria-label={`Redemptions for ${row.code}`}
      className="border-border bg-card rounded-2xl border p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-foreground text-sm font-semibold">Redemptions</h3>
            <span className="text-muted-foreground font-mono text-xs">{row.code}</span>
          </div>
          <p className="text-muted-foreground mt-1 text-xs tabular-nums">
            Remaining: <span className="text-foreground font-semibold">{row.remaining}</span> of{' '}
            {row.perCodeRedemptionCap}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close redemptions"
          className="text-muted-foreground hover:bg-muted focus-visible:ring-ring rounded-md p-1.5 transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {hasRedemptions ? (
        <ul className="divide-border mt-4 divide-y">
          {row.redemptions.map((redemption) => (
            <li key={redemption.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
              <span className="text-foreground inline-flex items-center gap-1.5 text-sm font-medium">
                <Building2 className="text-muted-foreground h-3.5 w-3.5" aria-hidden="true" />
                {redemption.companyName}
              </span>
              <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                <User className="h-3 w-3" aria-hidden="true" />
                {redemption.actorLabel ?? 'System'}
              </span>
              <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs tabular-nums">
                <Wallet className="h-3 w-3" aria-hidden="true" />
                {redemption.grantedLabel}
              </span>
              <span className="text-muted-foreground ml-auto inline-flex items-center gap-1.5 text-xs">
                <Clock className="h-3 w-3" aria-hidden="true" />
                <LocalDate iso={redemption.redeemedAtIso} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-4 py-8 text-center">
          <span className="bg-success/10 mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl">
            <Wallet className="text-success h-5 w-5" aria-hidden="true" />
          </span>
          <h4 className="text-foreground text-sm font-semibold">No redemptions yet</h4>
          <p className="text-muted-foreground mx-auto mt-1 max-w-xs text-xs leading-relaxed">
            All {row.perCodeRedemptionCap} redemptions are still available.
          </p>
        </div>
      )}
    </section>
  );
}
