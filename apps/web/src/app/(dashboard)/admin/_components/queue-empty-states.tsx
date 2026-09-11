import Link from 'next/link';
import { Coffee } from 'lucide-react';

/**
 * BAL-548 / ADR-1055 — the queue's two empty states. Server Components, no I/O.
 *
 * `QueueEmpty` — TRUE-ZERO: nothing open anywhere. Explains what lands here rather than
 * defining the section by absence, per CLAUDE.md's empty-state rule.
 * `QueueFilteredEmpty` — a filter matched nothing. Framed as a GOOD outcome (`success` tint),
 * the one action clears the filter.
 *
 * ⚠ The design prototype's true-zero CTA is "See capture health" — a page BAL-550 has not
 * built. Shipping that link would be dead. This links to `/admin/catalogue` instead;
 * // BAL-550 swap to the capture-health surface once it ships.
 */
export function QueueEmpty(): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-2xl border py-16 text-center">
      <div className="from-primary/10 mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br to-transparent">
        <Coffee className="text-primary size-6" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">Nothing needs a person right now</h3>
      <p className="text-muted-foreground mx-auto mt-1.5 max-w-md text-sm leading-relaxed">
        {/* pending-MJ */}
        Every open item has been actioned or closed itself. New ones land here the moment a sweep
        finds one — a failed recording, an overdue receivable, an application waiting on review.
      </p>
      <Link
        href="/admin/catalogue"
        className="text-primary hover:text-primary/80 mt-4 inline-block text-sm font-medium"
      >
        Open config &amp; catalogue
      </Link>
    </div>
  );
}

interface QueueFilteredEmptyProps {
  readonly groupLabel: string;
  readonly groupHint: string;
}

export function QueueFilteredEmpty({
  groupLabel,
  groupHint,
}: Readonly<QueueFilteredEmptyProps>): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-2xl border py-16 text-center">
      <div className="bg-success/10 mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl">
        <Coffee className="text-success size-6" aria-hidden="true" />
      </div>
      <h3 className="text-foreground text-lg font-semibold">
        Nothing open in {groupLabel.toLowerCase()}
      </h3>
      <p className="text-muted-foreground mx-auto mt-1.5 max-w-md text-sm leading-relaxed">
        {/* pending-MJ */}
        {groupHint} — every item has been actioned or closed itself.
      </p>
      <Link
        href="/admin"
        className="text-primary hover:text-primary/80 mt-4 inline-block text-sm font-medium"
      >
        Back to all
      </Link>
    </div>
  );
}
