'use client';

import { useId } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { CalendarConnection, CalendarProvider, SubCalendar } from '../_types/calendar';
import { SettingsEyebrow } from './settings-card';

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

/** A calendar as the picker names it — in the list and, once chosen, on the trigger. */
function calendarOptionLabel(cal: SubCalendar): string {
  return cal.primary ? `${cal.name} (Primary)` : cal.name;
}

/**
 * "Where bookings go" for ONE connection. The trigger and description ids come from `useId`
 * (prefixed with the provider for readability), so they stay unique however many accounts —
 * of the same provider or not — render on the page; a fixed id duplicates the moment a second
 * panel mounts. The trigger value falls back to the placeholder (never a client-side
 * auto-correct) when `targetCalendarId` is null (edge 9) or points at a calendar no longer in
 * `subCalendars` (edge 10, a rename/removal at the provider between provisions).
 */
export function CalendarTargetCalendarPanel({
  connection,
  provider,
  pending,
  disabled = false,
  onChange,
}: Readonly<CalendarTargetCalendarPanelProps>): React.JSX.Element {
  const idBase = `target-calendar-${provider}-${useId()}`;
  const triggerId = `${idBase}-trigger`;
  const descriptionId = `${idBase}-description`;
  const { targetCalendarId, subCalendars } = connection;
  const targetIsStale =
    targetCalendarId !== null && !subCalendars.some((cal) => cal.id === targetCalendarId);
  const selectValue = targetIsStale ? '' : (targetCalendarId ?? '');
  const selected = subCalendars.find((cal) => cal.id === selectValue);
  const selectedLabel = selected ? calendarOptionLabel(selected) : undefined;

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 sm:flex-1">
        <SettingsEyebrow as="label" htmlFor={triggerId} className="block">
          Where bookings go
        </SettingsEyebrow>
        <p id={descriptionId} className="text-muted-foreground mt-1 text-xs leading-relaxed">
          Confirmed consultations on this account are added to this calendar. We start with your
          primary one — change it any time.
        </p>
        {targetIsStale && (
          <p className="text-warning-strong mt-1 text-xs leading-relaxed">
            The calendar bookings were going to is no longer on this account — pick another.
          </p>
        )}
      </div>
      <Select value={selectValue} onValueChange={onChange} disabled={pending || disabled}>
        {/* Sized to the chosen calendar's name — Google names the primary calendar after the
            account email — from 240px up to 60% of the row, then truncated with an ellipsis;
            the full name stays on `title`. Full width, never wider, when stacked on mobile. */}
        <SelectTrigger
          id={triggerId}
          size="sm"
          title={selectedLabel}
          className="w-full max-w-full min-w-0 text-[13px] data-[size=sm]:h-11 sm:w-auto sm:max-w-[60%] sm:min-w-[240px] sm:data-[size=sm]:h-8"
          aria-describedby={descriptionId}
        >
          <SelectValue placeholder="Choose a calendar">
            <span className="block truncate">{selectedLabel}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {subCalendars.map((cal) => (
            <SelectItem key={cal.id} value={cal.id}>
              {calendarOptionLabel(cal)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
