'use client';

import { useCallback, useId, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import type { ResolvedJoinRequestRow } from '@balo/db';
import { formatShortDate } from '@/components/balo/domain-join/format';
import { cn } from '@/lib/utils';

const STATUS_VERB: Record<ResolvedJoinRequestRow['status'], string> = {
  approved: 'Approved',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

function personName(person: { firstName: string | null; lastName: string | null }): string {
  return [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
}

function ResolvedRow({ item }: Readonly<{ item: ResolvedJoinRequestRow }>): React.JSX.Element {
  const approved = item.status === 'approved';
  const requesterName = personName(item.requester);
  const displayName = requesterName.length > 0 ? requesterName : item.requester.email;
  const resolverName = item.resolver ? personName(item.resolver) : '';

  const verb = STATUS_VERB[item.status];
  const by = resolverName.length > 0 ? `${verb} by ${resolverName}` : verb;
  const when = item.resolvedAt === null ? '' : ` · ${formatShortDate(item.resolvedAt)}`;

  return (
    <div className="flex items-center gap-3 py-2.5">
      <span
        aria-hidden="true"
        className={cn(
          'grid h-7 w-7 flex-none place-items-center rounded-full',
          approved ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
        )}
      >
        {approved ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-sm font-medium">
          {displayName}
          <span className="text-muted-foreground font-normal"> · {item.requester.email}</span>
        </div>
        <div className="text-muted-foreground text-xs">{`${by}${when}`}</div>
      </div>
    </div>
  );
}

/**
 * The collapsed "Resolved (N)" disclosure (BAL-347 history). Collapsed by default;
 * expands to the approved/declined/withdrawn rows with "…by {Name}" attribution.
 */
export function ResolvedDisclosure({
  resolved,
}: Readonly<{ resolved: ReadonlyArray<ResolvedJoinRequestRow> }>): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  if (resolved.length === 0) return null;

  return (
    <div className="border-border mt-4 border-t pt-3.5">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm font-semibold"
      >
        <ChevronDown
          className={cn('h-4 w-4 transition-transform', open ? 'rotate-0' : '-rotate-90')}
          aria-hidden="true"
        />
        Resolved ({resolved.length})
      </button>
      {/* Always rendered (toggled via `hidden`) so the `aria-controls` target node is
          always present in the DOM — a reference to an absent node is a dangling a11y
          relationship. */}
      <div id={panelId} hidden={!open} className="mt-1.5">
        {resolved.map((item) => (
          <ResolvedRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}
