'use client';

import { useId } from 'react';
import { CalendarSubCalendarRow } from './calendar-sub-calendar-row';
import { SettingsEyebrow } from './settings-card';
import type { CalendarConnection, CalendarProvider } from '../_types/calendar';

interface CalendarBusyCalendarsPanelProps {
  readonly connection: CalendarConnection;
  readonly pending: boolean;
  /** BAL-397 fix round — set by `reconnect_needed`, where the panel is shown but must be
   *  genuinely INERT. Threaded all the way down to each row's `Switch`; a dimming class on an
   *  ancestor is presentation, not inertness. */
  readonly disabled?: boolean;
  readonly onToggle: (id: string, checked: boolean, provider: CalendarProvider) => void;
}

/**
 * "Busy calendars" for ONE connection — a labelled group of sub-calendar toggles, so each
 * Switch is announced within the account it belongs to. The group label's id comes from
 * `useId`, so several accounts on one page never share an id.
 *
 * If `subCalendars` is empty (a re-provision that found nothing writable while status is
 * somehow ACTIVE), this renders an invitation rather than hiding — balo-ui's "keep with an
 * invitation" rule.
 */
export function CalendarBusyCalendarsPanel({
  connection,
  pending,
  disabled = false,
  onToggle,
}: Readonly<CalendarBusyCalendarsPanelProps>): React.JSX.Element {
  const labelId = useId();

  return (
    <fieldset aria-labelledby={labelId} className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
      <SettingsEyebrow as="p" id={labelId}>
        Busy calendars
      </SettingsEyebrow>

      {connection.subCalendars.length === 0 ? (
        // ⚠ INVITATION-FRAMED, NEVER "No X yet" (BAL-397 fix round, UX WARNING). CLAUDE.md
        // names the absence framing as the disallowed pattern: this is a recoverable state,
        // so the title leads with the action that recovers it.
        <div className="border-border mt-1 rounded-lg border border-dashed px-3 py-2.5">
          <p className="text-foreground text-[13px] font-medium">
            Reconnect to find your calendars
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
            We haven&apos;t been able to read any calendars on this account. Reconnect and
            we&apos;ll take another look.
          </p>
        </div>
      ) : (
        <div className="flex flex-col">
          {connection.subCalendars.map((cal) => (
            <CalendarSubCalendarRow
              key={cal.id}
              calendar={cal}
              // BAL-397 — the toggle's provider comes off the CONNECTION row,
              // never the sub-calendar row (pre-flight decision #8). `calendar_connections
              // .provider` and `calendar_sub_calendars.provider` are separate columns, each
              // independently narrowed by the API's `mapProvider` (which silently coerces
              // anything unknown to a default). If they ever disagreed, the section's
              // `connections.find(c => c.provider === provider)` missed: the optimistic
              // update applied to nothing, the switch didn't move, and a failed toggle
              // "reverted" to a value that was never there — while the server, resolving by
              // `calendarId`, succeeded. Silent UI/DB divergence.
              onToggle={(id, checked) => onToggle(id, checked, connection.provider)}
              pending={pending}
              disabled={disabled}
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}
