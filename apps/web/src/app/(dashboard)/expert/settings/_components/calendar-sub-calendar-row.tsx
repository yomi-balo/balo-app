'use client';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { SubCalendar } from '../_types/calendar';

interface CalendarSubCalendarRowProps {
  calendar: SubCalendar;
  /**
   * ⚠ NO `provider` ARGUMENT (BAL-397 fix round). The owning connection's provider is the only
   * correct one, and this row cannot see it — `calendar.provider` is a SEPARATE column that can
   * disagree. `CalendarBusyCalendarsPanel` closes over `connection.provider` and supplies it;
   * see the note at that call site for what the divergence used to cost.
   */
  onToggle: (id: string, checked: boolean) => void;
  /** BAL-397 §9.3 — set while this row's toggle mutation is in flight. Disables the Switch
   *  (prevents a double-fire race) and reflects `aria-busy` for screen-reader users. */
  pending?: boolean;
  /** BAL-397 fix round — the panel is shown but INERT (`reconnect_needed`). Distinct from
   *  `pending`: nothing is in flight, so no `aria-busy`; the control is simply not operable. */
  disabled?: boolean;
}

/**
 * One sub-calendar's busy toggle: colour dot, name, a "Primary" tag, and the Switch. The row
 * keeps the 44px touch height on mobile and tightens from `sm` up.
 */
export function CalendarSubCalendarRow({
  calendar,
  onToggle,
  pending = false,
  disabled = false,
}: Readonly<CalendarSubCalendarRowProps>): React.JSX.Element {
  const switchLabel = calendar.primary
    ? `${calendar.name} always blocks time and can't be turned off`
    : `Block time from ${calendar.name}`;

  return (
    <div aria-busy={pending} className="flex min-h-11 items-center gap-2.5 sm:min-h-9">
      <div
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: calendar.color ?? 'var(--primary)' }}
        aria-hidden="true"
      />

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={cn(
            'text-foreground truncate text-[13px]',
            calendar.primary ? 'font-medium' : 'font-normal'
          )}
        >
          {calendar.name}
        </span>
        {calendar.primary && (
          <span className="border-border bg-muted text-muted-foreground shrink-0 rounded-md border px-1.5 text-[10px] leading-4 font-medium">
            Primary
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {calendar.primary && <span className="text-muted-foreground text-[11px]">Always on</span>}
        <Switch
          checked={calendar.conflictChecking}
          onCheckedChange={(checked) => !calendar.primary && onToggle(calendar.id, checked)}
          disabled={calendar.primary || pending || disabled}
          aria-label={switchLabel}
        />
      </div>
    </div>
  );
}
