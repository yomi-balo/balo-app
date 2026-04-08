'use client';

import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { SubCalendar } from '../_types/calendar';

interface CalendarSubCalendarRowProps {
  calendar: SubCalendar;
  onToggle: (id: string, checked: boolean, provider: SubCalendar['provider']) => void;
}

export function CalendarSubCalendarRow({
  calendar,
  onToggle,
}: Readonly<CalendarSubCalendarRowProps>): React.JSX.Element {
  return (
    <div
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
          onCheckedChange={(checked) =>
            !calendar.primary && onToggle(calendar.id, checked, calendar.provider)
          }
          disabled={calendar.primary}
          aria-label={`Use ${calendar.name} for conflict checking`}
        />
      </div>
    </div>
  );
}
