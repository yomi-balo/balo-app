'use client';

import { RotateCcw, Sparkles, Ticket, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { PromoDisplayStatus } from '@/lib/promo-codes/promo-codes-view';

/**
 * Promo-code empty states — decisions, never bare absence (balo-ui rule).
 *
 * `ZeroEmptyState` is the true-zero surface: no codes exist. It EXPLAINS what a promo
 * code does (grants a slice of AUD credit on redemption, bounded by a cap + window) and
 * invites the admin to mint the first one — an invitation, never a bare "No codes yet".
 *
 * `FilteredEmptyState` shows when a status filter is on but nothing matches: each slice
 * gets copy framed as a fact, and the ONE action clears back to "All".
 */

interface ZeroEmptyStateProps {
  onMint: () => void;
}

export function ZeroEmptyState({ onMint }: Readonly<ZeroEmptyStateProps>): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-2xl border px-8 py-14 text-center">
      <span className="from-primary/10 to-accent/10 mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br">
        <Ticket className="text-primary h-6 w-6" aria-hidden="true" />
      </span>
      <h3 className="text-foreground text-lg font-semibold">Mint your first promo code</h3>
      <p className="text-muted-foreground mx-auto mt-2 max-w-lg text-sm leading-relaxed">
        A promo code grants a fixed slice of AUD credit each time it&apos;s redeemed, up to a total
        redemption cap and within a validity window you set. Mint your first one and it will appear
        here with its usage, remaining cap, and redemptions.
      </p>
      <div className="mt-5">
        <Button onClick={onMint}>
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          Mint your first code
        </Button>
      </div>
    </div>
  );
}

interface FilteredCopy {
  title: string;
  body: string;
}

const FILTERED_COPY: Record<PromoDisplayStatus, FilteredCopy> = {
  active: {
    title: 'No live codes right now',
    body: 'No promo code is currently redeemable. Mint one, or check the scheduled and expired codes.',
  },
  scheduled: {
    title: 'Nothing scheduled',
    body: 'No promo code is waiting to start. Mint one with a future start date to schedule it.',
  },
  exhausted: {
    title: 'Nothing exhausted',
    body: 'No promo code has hit its redemption cap — there is headroom on every code.',
  },
  expired: {
    title: 'Nothing expired',
    body: 'No promo code has passed its end date yet. Expired codes show here once their window closes.',
  },
  deactivated: {
    title: 'Nothing deactivated',
    body: 'No promo code has been turned off. Deactivated codes show here so you can review them.',
  },
};

const FILTER_ICON: Record<PromoDisplayStatus, { icon: LucideIcon; wrap: string; tone: string }> = {
  active: { icon: Ticket, wrap: 'bg-success/10', tone: 'text-success' },
  scheduled: { icon: Ticket, wrap: 'bg-info/10', tone: 'text-info' },
  exhausted: { icon: Ticket, wrap: 'bg-warning/10', tone: 'text-warning' },
  expired: { icon: Ticket, wrap: 'bg-muted', tone: 'text-muted-foreground' },
  deactivated: { icon: Ticket, wrap: 'bg-destructive/10', tone: 'text-destructive' },
};

interface FilteredEmptyStateProps {
  filter: PromoDisplayStatus;
  onClear: () => void;
}

export function FilteredEmptyState({
  filter,
  onClear,
}: Readonly<FilteredEmptyStateProps>): React.JSX.Element {
  const copy = FILTERED_COPY[filter];
  const { icon: Icon, wrap, tone } = FILTER_ICON[filter];
  return (
    <div className="border-border bg-card rounded-2xl border px-8 py-14 text-center">
      <span
        className={cn('mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl', wrap)}
      >
        <Icon className={cn('h-6 w-6', tone)} aria-hidden="true" />
      </span>
      <h3 className="text-foreground text-lg font-semibold">{copy.title}</h3>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm leading-relaxed">
        {copy.body}
      </p>
      <div className="mt-5">
        <Button onClick={onClear} variant="outline">
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Show all codes
        </Button>
      </div>
    </div>
  );
}
