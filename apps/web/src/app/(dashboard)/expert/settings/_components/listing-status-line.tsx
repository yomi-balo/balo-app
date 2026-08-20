import { CheckCircle2, Circle } from 'lucide-react';
import type { ChecklistStatus } from '@/lib/actions/expert-checklist';

interface ListingStatusLineProps {
  readonly status: ChecklistStatus;
}

/**
 * BAL-414 (D11) — a ONE-LINE status stating the expert's current Balo search-listing state.
 * Not a dismissible banner, not a redesign. Derived from the ALREADY-RETURNED
 * `ChecklistStatus` (`allComplete` / `completedCount`) — no second query, and the
 * `ChecklistStatus` shape is unchanged.
 *
 * Not-listed is INVITATION-framed and actionable ("You're not appearing in search yet — {n} to
 * go"), never absence-framed ("No X yet") — balo-ui-skill's empty-state rule. Listed is a
 * brief, quiet confirmation. Tokens, not hardcoded colours, so both states are correct in
 * dark mode for free.
 */
export function ListingStatusLine({ status }: Readonly<ListingStatusLineProps>): React.JSX.Element {
  if (status.allComplete) {
    return (
      <p className="text-success mb-4 flex items-center gap-1.5 text-sm font-medium">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        You&apos;re appearing in search.
      </p>
    );
  }

  const totalItems = Object.keys(status.items).length;
  const remaining = totalItems - status.completedCount;
  const itemNoun = remaining === 1 ? 'item' : 'items';

  return (
    <p className="text-muted-foreground mb-4 flex items-center gap-1.5 text-sm">
      <Circle className="h-4 w-4 shrink-0" aria-hidden="true" />
      You&apos;re not appearing in search yet — {remaining} {itemNoun} to go.
    </p>
  );
}
