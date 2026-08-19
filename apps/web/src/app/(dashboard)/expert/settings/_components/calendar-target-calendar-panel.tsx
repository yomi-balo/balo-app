'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { CalendarConnection, CalendarProvider } from '../_types/calendar';

interface CalendarTargetCalendarPanelProps {
  readonly connection: CalendarConnection;
  readonly provider: CalendarProvider;
  readonly pending: boolean;
  /** BAL-397 fix round — set by `reconnect_needed`, where the panel is shown but must be
   *  genuinely INERT. Lands on the `SelectTrigger` itself, which is what removes it from the
   *  tab order; a dimming class on an ancestor does not. */
  readonly disabled?: boolean;
  readonly onChange: (calendarId: string) => void;
}

/**
 * BAL-397 §8/§11 — the shipped card hardcoded `id="target-calendar-select"` (a DUPLICATE DOM
 * id the moment two connections render). `id` is scoped per provider here, and the trigger
 * value falls back to the placeholder (never a client-side auto-correct) when
 * `targetCalendarId` is null (edge 9) or points at a calendar no longer in `subCalendars`
 * (edge 10, a rename/removal at the provider between provisions).
 */
export function CalendarTargetCalendarPanel({
  connection,
  provider,
  pending,
  disabled = false,
  onChange,
}: Readonly<CalendarTargetCalendarPanelProps>): React.JSX.Element {
  const triggerId = `target-calendar-${provider}`;
  const descriptionId = `target-calendar-${provider}-description`;
  const { targetCalendarId, subCalendars } = connection;
  const targetIsStale =
    targetCalendarId !== null && !subCalendars.some((cal) => cal.id === targetCalendarId);
  const selectValue = targetIsStale ? '' : (targetCalendarId ?? '');

  return (
    <div className="px-5 py-4">
      <label htmlFor={triggerId} className="text-foreground mb-1 block text-sm font-medium">
        Where bookings go
      </label>
      <p id={descriptionId} className="text-muted-foreground mb-3 text-xs leading-relaxed">
        Confirmed consultations on this account are added to this calendar. We start with your
        primary one — change it any time.
      </p>
      {targetIsStale && (
        <p className="text-warning mb-2 text-xs leading-relaxed">
          The calendar bookings were going to is no longer on this account — pick another.
        </p>
      )}
      <Select value={selectValue} onValueChange={onChange} disabled={pending || disabled}>
        <SelectTrigger id={triggerId} size="sm" className="w-full" aria-describedby={descriptionId}>
          <SelectValue placeholder="Choose a calendar" />
        </SelectTrigger>
        <SelectContent>
          {subCalendars.map((cal) => (
            <SelectItem key={cal.id} value={cal.id}>
              {cal.name}
              {cal.primary ? ' (Primary)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
