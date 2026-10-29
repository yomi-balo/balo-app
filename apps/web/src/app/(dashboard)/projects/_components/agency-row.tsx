'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { ChevronRight, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import type { ProjectsInboxFilter } from '@/lib/analytics';
import type { AgencyRowView, EngagementDeliveryState } from '@/lib/projects-inbox/portfolio-row';

/**
 * AgencyRow — one project on the agency oversight lens (prototype `AgencyRow`). Oversight, not
 * an inbox: it never says "Needs you" and carries no unread dot. The whole row is a link to the
 * engagement workspace with `?from=agency`, so the workspace back link returns to the lens.
 * One DOM, responsive: stacked on mobile, a five-column grid from `md`.
 */

export const AGENCY_ROW_GRID = 'md:grid-cols-[minmax(0,1fr)_172px_196px_88px_16px]';

export const STATE_LABEL: Record<EngagementDeliveryState, string> = {
  changes_requested: 'Changes requested',
  pending_acceptance: 'Awaiting client review',
  in_delivery: 'In delivery',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STATE_TONE: Record<EngagementDeliveryState, string> = {
  changes_requested: 'bg-warning/15 text-warning-strong',
  pending_acceptance: 'bg-info/10 text-info-strong',
  in_delivery: 'bg-primary/10 text-primary',
  completed: 'bg-success/15 text-success-strong',
  cancelled: 'bg-muted text-muted-foreground',
};

const AVATAR_HUES = [262, 199, 152, 28, 340, 220, 172, 48];

/** A stable per-person hue so the same expert reads the same everywhere. */
function hueFor(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 997;
  return AVATAR_HUES[hash % AVATAR_HUES.length] ?? 220;
}

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

interface AgencyAvatarProps {
  id: string;
  name: string;
  size?: number;
  className?: string;
}

/**
 * Initials on a tint of the person's hue. Light and dark values are separate custom properties
 * so the initials keep contrast in both themes. Decorative: the name sits beside it.
 */
export function AgencyAvatar({
  id,
  name,
  size = 26,
  className,
}: Readonly<AgencyAvatarProps>): React.JSX.Element {
  const hue = hueFor(id);
  const style = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.38),
    '--av-bg': `hsl(${hue} 70% 45% / 0.1)`,
    '--av-fg': `hsl(${hue} 60% 38%)`,
    '--av-bg-dark': `hsl(${hue} 70% 60% / 0.2)`,
    '--av-fg-dark': `hsl(${hue} 80% 75%)`,
  } as React.CSSProperties;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-(color:--av-bg) font-semibold text-(color:--av-fg) dark:bg-(color:--av-bg-dark) dark:text-(color:--av-fg-dark)',
        className
      )}
      style={style}
    >
      {initialsFor(name)}
    </span>
  );
}

export function StateChip({
  state,
}: Readonly<{ state: EngagementDeliveryState }>): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        STATE_TONE[state]
      )}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

interface AgencyRowProps {
  row: AgencyRowView;
  agencyName: string;
  fromFilter: ProjectsInboxFilter;
  last: boolean;
  /** Completed and cancelled rows: dimmed, no note or progress detail. */
  finished?: boolean;
}

export function AgencyRow({
  row,
  agencyName,
  fromFilter,
  last,
  finished = false,
}: Readonly<AgencyRowProps>): React.JSX.Element {
  const { deliverer } = row;
  const name = deliverer.isViewer ? 'You' : deliverer.name;
  const detail = finished ? null : row.detailLabel;
  const note = finished ? null : row.changeRequestNote;
  const markerText = `No longer at ${agencyName}`;

  const ariaLabel = [
    `${row.title} for ${row.companyName}, delivered by ${deliverer.isViewer ? 'you' : deliverer.name}, ${STATE_LABEL[row.deliveryState]}`,
    deliverer.isFormerMember ? `no longer at ${agencyName}` : null,
    detail,
    note === null ? null : `change request: ${note}`,
    `updated ${row.updatedRelative}`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');

  const handleClick = useCallback(() => {
    track(PROJECTS_INBOX_EVENTS.INBOX_LIST_ROW_CLICKED, {
      lens: 'agency',
      request_id: null,
      stage: row.deliveryState,
      needs_you: false,
      from_filter: fromFilter,
    });
  }, [row.deliveryState, fromFilter]);

  return (
    <Link
      href={row.href}
      aria-label={ariaLabel}
      onClick={handleClick}
      className={cn(
        'hover:bg-muted/60 focus-visible:ring-ring relative grid grid-cols-[32px_minmax(0,1fr)_16px] gap-x-3 gap-y-2 px-4 py-3.5 transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset motion-reduce:transition-none md:items-center md:gap-4 md:px-[18px]',
        AGENCY_ROW_GRID,
        !last && 'border-border/60 border-b',
        finished && 'bg-muted/40'
      )}
    >
      <AgencyAvatar
        id={deliverer.expertProfileId}
        name={deliverer.name}
        size={32}
        className="col-start-1 row-span-4 row-start-1 self-start md:hidden"
      />

      <div className="order-1 col-start-2 min-w-0 md:order-none md:col-auto">
        <p className="text-foreground truncate text-sm font-semibold">{row.title}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{row.companyName}</p>
        {note !== null && (
          <p className="text-muted-foreground mt-1.5 flex min-w-0 items-center gap-1.5 text-xs">
            <MessageSquare className="text-warning h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">“{note}”</span>
          </p>
        )}
      </div>

      <div className="order-3 col-start-2 flex min-w-0 items-center gap-2 md:order-none md:col-auto">
        <AgencyAvatar
          id={deliverer.expertProfileId}
          name={deliverer.name}
          className="hidden md:inline-flex"
        />
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 md:block">
          <p
            className={cn(
              'truncate text-[13px]',
              deliverer.isViewer
                ? 'text-muted-foreground font-semibold'
                : 'text-foreground font-medium'
            )}
          >
            {name}
          </p>
          {deliverer.isFormerMember && (
            <p className="text-muted-foreground/80 truncate text-[11.5px] before:mr-1.5 before:content-['·'] md:before:hidden">
              {markerText}
            </p>
          )}
          <span
            aria-hidden="true"
            className="text-muted-foreground text-[11.5px] before:mr-1.5 before:content-['·'] md:hidden"
          >
            {row.updatedRelative}
          </span>
        </div>
      </div>

      <div className="order-2 col-start-2 md:order-none md:col-auto">
        <StateChip state={row.deliveryState} />
        {detail !== null && (
          <p className="text-muted-foreground mt-1 text-[11.5px] tabular-nums">{detail}</p>
        )}
      </div>

      <span className="text-muted-foreground order-4 hidden text-xs whitespace-nowrap md:order-none md:block md:text-right">
        {row.updatedRelative}
      </span>
      <ChevronRight
        className="text-muted-foreground col-start-3 row-start-1 mt-0.5 h-4 w-4 md:col-auto md:row-auto md:mt-0"
        aria-hidden="true"
      />
    </Link>
  );
}
