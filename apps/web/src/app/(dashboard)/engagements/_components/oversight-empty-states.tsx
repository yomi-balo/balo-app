'use client';

import Link from 'next/link';
import {
  ArrowRight,
  CheckCircle2,
  Coffee,
  Flag,
  Inbox,
  Layers,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { STALLED_AFTER_DAYS } from '@/lib/engagements/oversight-constants';
import type { OversightFilter } from '@/lib/engagements/oversight-row';

/**
 * Oversight empty states — decisions, never bare absence (balo-ui rule).
 *
 * `FilteredEmptyState` shows when a filter is on but nothing matches: each slice
 * gets an invitation framed as a good outcome ("Nothing has gone quiet"), and the
 * ONE action clears back to the in-flight default.
 *
 * `ZeroEmptyState` is the true-zero surface: it EXPLAINS how engagements come to
 * exist (they materialise when a client accepts a proposal → kickoff) and points
 * at the pipeline — never a bare "No engagements yet".
 */

interface FilteredCopy {
  icon: LucideIcon;
  iconWrap: string;
  iconTone: string;
  title: string;
  body: string;
}

const FILTERED_COPY: Record<OversightFilter, FilteredCopy> = {
  in_flight: {
    icon: Coffee,
    iconWrap: 'bg-success/10',
    iconTone: 'text-success',
    title: 'Nothing in flight',
    body: 'No engagement is in active delivery or client review right now.',
  },
  active: {
    icon: Inbox,
    iconWrap: 'bg-primary/10',
    iconTone: 'text-primary',
    title: 'Nothing in active delivery',
    body: 'No engagement is mid-delivery right now.',
  },
  in_review: {
    icon: CheckCircle2,
    iconWrap: 'bg-success/10',
    iconTone: 'text-success',
    title: 'Nothing waiting on a client',
    body: 'No engagement is sitting in client review right now — no acceptance is about to trigger.',
  },
  stalled: {
    icon: Coffee,
    iconWrap: 'bg-success/10',
    iconTone: 'text-success',
    title: 'Nothing has gone quiet',
    body: `No engagement has been silent for ${STALLED_AFTER_DAYS}+ days. Delivery is moving.`,
  },
  completed: {
    icon: Flag,
    iconWrap: 'bg-primary/10',
    iconTone: 'text-primary',
    title: 'No completed engagements yet',
    body: 'When a client accepts a finished project — or it auto-accepts after the review window — it lands here.',
  },
  cancelled: {
    icon: CheckCircle2,
    iconWrap: 'bg-success/10',
    iconTone: 'text-success',
    title: 'Nothing cancelled',
    body: 'No engagement has been stopped. Cancellations show here with the reason on the record.',
  },
};

interface FilteredEmptyStateProps {
  filter: OversightFilter;
  onClear: () => void;
}

export function FilteredEmptyState({
  filter,
  onClear,
}: Readonly<FilteredEmptyStateProps>): React.JSX.Element {
  const copy = FILTERED_COPY[filter];
  const Icon = copy.icon;
  // On the default in-flight view the "Back to in flight" reset would be a no-op
  // (we're already there), so the single emphasised action points at the pipeline
  // instead — where the next engagement is born.
  const isDefault = filter === 'in_flight';
  return (
    <div className="border-border bg-card rounded-2xl border px-8 py-14 text-center">
      <span
        className={cn(
          'mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl',
          copy.iconWrap
        )}
      >
        <Icon className={cn('h-6 w-6', copy.iconTone)} aria-hidden="true" />
      </span>
      <h3 className="text-foreground text-lg font-semibold">{copy.title}</h3>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm leading-relaxed">
        {copy.body}
      </p>
      <div className="mt-5">
        {isDefault ? (
          <Button asChild>
            <Link href="/projects?lens=admin">
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
              Go to the pipeline
            </Link>
          </Button>
        ) : (
          <Button onClick={onClear} variant="outline">
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Back to in flight
          </Button>
        )}
      </div>
    </div>
  );
}

export function ZeroEmptyState(): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-2xl border px-8 py-14 text-center">
      <span className="from-primary/10 to-accent/10 mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br">
        <Layers className="text-primary h-6 w-6" aria-hidden="true" />
      </span>
      <h3 className="text-foreground text-lg font-semibold">No engagements in flight yet</h3>
      <p className="text-muted-foreground mx-auto mt-2 max-w-lg text-sm leading-relaxed">
        An engagement is created the moment a client accepts a proposal — that&apos;s when a project
        kicks off and delivery begins. Approve a kickoff from the pipeline and the first one will
        appear here, with its milestones, value, and activity.
      </p>
      <div className="mt-5">
        <Button asChild>
          <Link href="/projects?lens=admin">
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
            Go to the pipeline
          </Link>
        </Button>
      </div>
    </div>
  );
}
