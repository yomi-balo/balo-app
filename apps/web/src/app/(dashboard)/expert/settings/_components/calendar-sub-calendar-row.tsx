'use client';

import { Badge } from '@/components/ui/badge';
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
    <div
      aria-busy={pending}
      className={cn(
        'hover:bg-muted/50 flex min-h-[44px] items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors'
      )}
    >
      {/* Calendar color dot */}
      <div
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: calendar.color ?? 'var(--primary)' }}
        aria-hidden="true"
      />

      {/* Calendar name + badge */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={cn(
            'text-foreground truncate text-sm',
            calendar.primary ? 'font-semibold' : 'font-normal'
          )}
        >
          {calendar.name}
        </span>
        {calendar.primary && (
          <Badge
            variant="secondary"
            className="bg-primary/10 text-primary border-primary/20 border px-1.5 py-0 text-[10px] font-bold"
          >
            Primary
          </Badge>
        )}
      </div>

      {/* Toggle */}
      <div className="flex shrink-0 items-center gap-2">
        {calendar.primary && (
          <span className="text-muted-foreground text-[11px] italic">Always on</span>
        )}
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
