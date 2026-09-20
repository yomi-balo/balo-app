'use client';

import { Fragment, useEffect, useState } from 'react';
import { CalendarClock, CalendarX, MoreVertical, UserPlus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { CaseConsultationRowView } from '@/lib/cases/case-view-types';

/**
 * Menu items come from `row`'s server-resolved flags; renders null when none are true.
 * `canInvite` is hard-false today — the item stays wired for a future flip.
 */

export type ConsultationRowActionVerb = 'invite' | 'reschedule' | 'propose' | 'cancel';

export interface ConsultationRowMenuProps {
  row: CaseConsultationRowView;
  onAction: (verb: ConsultationRowActionVerb, row: CaseConsultationRowView) => void;
  /**
   * For focus restoration: `case-surface.tsx` keeps a `meetingId → HTMLButtonElement` map so a
   * dialog opened from this menu can restore focus here after the Radix menu has unmounted.
   */
  registerTrigger?: (node: HTMLButtonElement | null) => void;
}

interface MenuItemSpec {
  key: ConsultationRowActionVerb;
  label: string;
  icon: LucideIcon;
  destructive?: boolean;
}

function buildMenuItems(row: CaseConsultationRowView): MenuItemSpec[] {
  const items: MenuItemSpec[] = [];
  if (row.canInvite) {
    items.push({ key: 'invite', label: 'Invite a colleague', icon: UserPlus });
  }
  if (row.canReschedule) {
    items.push({ key: 'reschedule', label: 'Reschedule', icon: CalendarClock });
  }
  if (row.canProposeReschedule) {
    items.push({ key: 'propose', label: 'Propose a new time', icon: CalendarClock });
  }
  if (row.canCancel) {
    items.push({ key: 'cancel', label: 'Cancel consultation', icon: CalendarX, destructive: true });
  }
  return items;
}

/**
 * Always the absolute date/time, never "Tomorrow" — an overnight dwell would make the
 * control's name a lie. Renders in UTC first, like `LocalDateTime`, then upgrades to the
 * viewer's timezone in an effect so hydration cannot mismatch the attribute.
 */
function useMenuLabel(scheduledStartIso: string): string {
  const [zone, setZone] = useState('UTC');
  useEffect(() => {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved) setZone(resolved);
  }, []);
  const absolute = new Intl.DateTimeFormat('en-AU', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(scheduledStartIso));
  return `Actions for consultation on ${absolute}`;
}

export function ConsultationRowMenu({
  row,
  onAction,
  registerTrigger,
}: Readonly<ConsultationRowMenuProps>): React.JSX.Element | null {
  const items = buildMenuItems(row);
  const menuLabel = useMenuLabel(row.scheduledStartIso);

  if (items.length === 0) {
    return null;
  }

  const firstDestructiveIndex = items.findIndex((item) => item.destructive === true);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={registerTrigger}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={menuLabel}
          // `pointer-coarse:` grows the touch target to 44×44 (Tailwind ^4.2.1), overriding
          // `size="icon"` per `calendar-connection-menu.tsx`'s precedent; the negative margins
          // offset that larger box so it doesn't grow the row's height on touch.
          className="-mr-1.5 size-8 shrink-0 pointer-coarse:-mt-1.5 pointer-coarse:-mr-2.5 pointer-coarse:size-11"
        >
          <MoreVertical size={16} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={menuLabel}>
        {items.map((item, index) => (
          <Fragment key={item.key}>
            {index === firstDestructiveIndex && index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              variant={item.destructive ? 'destructive' : 'default'}
              onSelect={() => onAction(item.key, row)}
            >
              <item.icon aria-hidden="true" />
              {item.label}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
