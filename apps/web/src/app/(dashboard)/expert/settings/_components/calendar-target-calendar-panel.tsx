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
import { PROVIDER_META } from '../_lib/calendar-providers';
import { SettingsEyebrow } from './settings-card';

interface CalendarTargetCalendarPanelProps {
  readonly connection: CalendarConnection;
  readonly provider: CalendarProvider;
  readonly pending: boolean;
  /** BAL-397 fix round — set by `reconnect_needed`, where the panel is shown but must be
   *  genuinely INERT. Lands on the `SelectTrigger` itself, which is what removes it from the
   *  tab order; a dimming class on an ancestor does not. */
  readonly disabled?: boolean;
  /**
   * BAL-576 — the connection bookings actually land on, across every one of the expert's
   * connections (not just this one). `undefined` when no connection is writable anywhere.
   * Named for the description copy: this card's own targetness is `connection.isBookingTarget`.
   */
  readonly bookingTarget: CalendarConnection | undefined;
  readonly onChange: (calendarId: string) => void;
}

/** A calendar as the picker names it — in the list and, once chosen, on the trigger. */
function calendarOptionLabel(cal: SubCalendar): string {
  return cal.primary ? `${cal.name} (Primary)` : cal.name;
}

/** How the standby copy names the account bookings currently go to. Drops the parenthetical
 *  when the account's email is unknown — a row connected before BAL-575 and not reconnected
 *  since has none. */
function targetAccountLabel(target: CalendarConnection): string {
  const { label } = PROVIDER_META[target.provider];
  return target.providerEmail
    ? `your ${label} account (${target.providerEmail})`
    : `your ${label} account`;
}

/**
 * BAL-576 — "Where bookings go" is a claim about ONE connection out of the expert's whole set,
 * never about "this account" in isolation. Branches are evaluated in this order, and the FIRST
 * match wins:
 *
 *   1. `disabled` (reconnect_needed — the panel is inert): no routing claim at all. While a
 *      connection is broken nobody can book, and an older broken row regains the target on
 *      reconnect, so any routing sentence here would be wrong in some case. The amber notice
 *      above it carries the bookability fact.
 *   2. This connection IS the booking target: the prototype's wording, verbatim.
 *   3. Another connection is the target (standby):
 *      3a. This card has no calendar picked yet (`targetCalendarId === null`): name the target
 *          and stop there — NO "takes over if that account is disconnected" sentence. An older
 *          ACTIVE card with nothing picked becomes the target the MOMENT a calendar is picked
 *          (it out-ages the current target), so the takeover sentence would be false here —
 *          picking doesn't wait for a disconnect. The post-pick toast and the null→set refetch
 *          state the real outcome.
 *      3b. This card already has a calendar picked: the full two-sentence copy, since picking a
 *          DIFFERENT calendar here does not change targetness — only a disconnect does.
 *   4. No writable connection anywhere (given #1, this card is ACTIVE with a null target):
 *      the expert gets an ICS invite per booking instead (ADR-1044 Ruling 1) until they choose.
 */
function descriptionFor(
  connection: CalendarConnection,
  bookingTarget: CalendarConnection | undefined,
  disabled: boolean
): string {
  if (disabled) {
    return 'You can choose where bookings go once this account is reconnected.';
  }
  if (connection.isBookingTarget) {
    return 'Confirmed consultations are added to this calendar. We start with your primary one — change it any time.';
  }
  if (bookingTarget !== undefined) {
    const namesTarget = `Bookings go to one account at a time — right now that's ${targetAccountLabel(bookingTarget)}.`;
    if (connection.targetCalendarId === null) {
      return namesTarget;
    }
    return `${namesTarget} The calendar you pick here takes over if that account is disconnected.`;
  }
  return "Choose a calendar for your bookings. Until you do, we'll email you a calendar invite for each one.";
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
  bookingTarget,
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
          {descriptionFor(connection, bookingTarget, disabled)}
        </p>
        {targetIsStale && (
          <p className="text-warning-strong mt-1 text-xs leading-relaxed">
            The calendar chosen here is no longer on this account — pick another.
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
