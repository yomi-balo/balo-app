'use client';

import { Calendar as CalendarIcon, Info } from 'lucide-react';
import { SectionEmpty, SectionHead } from '@/components/balo/section/section-states';
import { Separator } from '@/components/ui/separator';
import { CalendarSubCalendarRow } from './calendar-sub-calendar-row';
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
 * BAL-397 §9.3 — "Busy calendars" for ONE connection. If `subCalendars` is empty (a
 * re-provision that found nothing writable while status is somehow ACTIVE), this renders the
 * `SectionEmpty` invitation rather than hiding — balo-ui's "keep with an invitation" rule.
 */
export function CalendarBusyCalendarsPanel({
  connection,
  pending,
  disabled = false,
  onToggle,
}: Readonly<CalendarBusyCalendarsPanelProps>): React.JSX.Element {
  return (
    <div className="px-5 py-4">
      <SectionHead icon={CalendarIcon} title="Busy calendars" />
      <p className="text-muted-foreground mb-2 text-sm leading-relaxed">
        When one of these has an event, that time won&apos;t be offered to clients.
      </p>

      {connection.subCalendars.length === 0 ? (
        // ⚠ INVITATION-FRAMED, NEVER "No X yet" (BAL-397 fix round, UX WARNING). CLAUDE.md
        // names the absence framing as the disallowed pattern: this is a recoverable state,
        // so the title leads with the action that recovers it.
        <SectionEmpty
          icon={CalendarIcon}
          title="Reconnect to find your calendars"
          body="We haven't been able to read any calendars on this account. Reconnect and we'll take another look."
        />
      ) : (
        <div>
          {connection.subCalendars.map((cal, index) => (
            <div key={cal.id}>
              {index > 0 && <Separator className="my-0" />}
              <CalendarSubCalendarRow
                calendar={cal}
                // BAL-397 fix round — the toggle's provider comes off the CONNECTION row,
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
            </div>
          ))}
          <div className="flex items-start gap-1.5 px-2.5 pt-2 pb-1">
            <Info className="text-muted-foreground mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="text-muted-foreground text-[11px] leading-relaxed">
              Events on enabled calendars will block that time slot from client bookings. Event
              titles and details are never visible to clients.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
