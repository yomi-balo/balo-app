'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { addDaysToDayKey, weekStartDayKey as weekStartOf } from '@/lib/calendar/zoned-grid';

interface WeekNavProps {
  readonly weekStartDayKey: string;
  readonly todayDayKey: string;
  readonly rangeLabel: string;
  readonly onNavigate: (weekStartDayKey: string) => void;
}

/**
 * BAL-498 — `[<] [date range] [>] [Today]`. "Today" is `aria-disabled`, NEVER `disabled`, when
 * the visible week already contains today — a disabled button traps focus and gives no feedback.
 */
export function WeekNav({
  weekStartDayKey,
  todayDayKey,
  rangeLabel,
  onNavigate,
}: Readonly<WeekNavProps>): React.JSX.Element {
  const weekEndDayKey = addDaysToDayKey(weekStartDayKey, 6);
  const containsToday = todayDayKey >= weekStartDayKey && todayDayKey <= weekEndDayKey;

  return (
    <div className="flex items-center gap-2">
      {/* A4 — `size="icon"` (36px) + a transparent `after:-inset-1.5` ring = a 48px tap target,
          without enlarging the visual chevrons. Same treatment as the mobile day nav in
          `week-grid.tsx`, so the two week/day controls stay consistent under the thumb. */}
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="Previous week"
        className="relative after:absolute after:-inset-1.5 after:content-['']"
        onClick={() => onNavigate(addDaysToDayKey(weekStartDayKey, -7))}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      </Button>
      <span className="text-foreground min-w-40 text-center text-sm font-medium">{rangeLabel}</span>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="Next week"
        className="relative after:absolute after:-inset-1.5 after:content-['']"
        onClick={() => onNavigate(addDaysToDayKey(weekStartDayKey, 7))}
      >
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn('min-h-11', containsToday && 'pointer-events-none opacity-50')}
        aria-disabled={containsToday}
        onClick={() => {
          if (!containsToday) {
            onNavigate(weekStartOf(todayDayKey));
          }
        }}
      >
        Today
      </Button>
    </div>
  );
}
