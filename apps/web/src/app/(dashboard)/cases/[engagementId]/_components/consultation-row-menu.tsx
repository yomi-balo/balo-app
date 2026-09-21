'use client';

import { Fragment } from 'react';
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
import { useAbsoluteConsultationTime } from '@/hooks/use-consultation-time-label';
import type { CaseConsultationRowView } from '@/lib/cases/case-view-types';

/**
 * Menu items come from `row`'s server-resolved flags alone, and the order is fixed; renders
 * null when none are true.
 */

export type ConsultationRowActionVerb = 'invite' | 'reschedule' | 'propose' | 'cancel';

/**
 * BAL-573 — WHICH control on the row opened an action, so a dialog can return focus to the one
 * that opened it rather than always the kebab. `'menu'` is the kebab; `'guests'` is the row's
 * guest-count control (`consultation-list.tsx`).
 */
export type ConsultationRowTriggerSlot = 'menu' | 'guests';

export interface ConsultationRowMenuProps {
  row: CaseConsultationRowView;
  /** Always fired with slot `'menu'` — this component IS the kebab. */
  onAction: (
    verb: ConsultationRowActionVerb,
    row: CaseConsultationRowView,
    slot: ConsultationRowTriggerSlot
  ) => void;
  /**
   * For focus restoration: `case-surface.tsx` keeps a `meetingId#slot → HTMLButtonElement` map
   * so a dialog opened from this menu can restore focus here after the Radix menu has unmounted.
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

/** The kebab's accessible name, built from the SHARED absolute time string so it cannot drift
 *  from the row's guest-count control label. */
function useMenuLabel(scheduledStartIso: string): string {
  return `Actions for consultation on ${useAbsoluteConsultationTime(scheduledStartIso)}`;
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
              onSelect={() => onAction(item.key, row, 'menu')}
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
