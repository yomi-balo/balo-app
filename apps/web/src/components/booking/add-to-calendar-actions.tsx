'use client';

import { CalendarPlus, Download } from 'lucide-react';
import { buildGoogleCalendarLink } from '@balo/shared/calendar';
import type { CalendarAddSurface } from '@balo/analytics/events';
import { Button } from '@/components/ui/button';
import { CALENDAR_EVENTS, track } from '@/lib/analytics';
import { downloadIcsEvent } from './ics';
import { openCalendarLink } from './open-calendar-link';

export interface AddToCalendarActionsProps {
  summary: string;
  startIso: string;
  durationMinutes: number;
  filename: string;
  surface: Extract<CalendarAddSurface, 'booking_confirmation' | 'intro_call_confirmation'>;
}

/**
 * The booked-step calendar affordances, shared by `StepBooked` and `StepBookedIntroCall`.
 * Google Calendar gets a one-click link because it may not add an emailed `.ics` invite on its own
 * (its "Add invitations to my calendar" setting); every other calendar app takes the download.
 */
export function AddToCalendarActions({
  summary,
  startIso,
  durationMinutes,
  filename,
  surface,
}: Readonly<AddToCalendarActionsProps>): React.JSX.Element {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + durationMinutes * 60_000);

  function handleGoogle(): void {
    track(CALENDAR_EVENTS.ADD_OPTION_CLICKED, { option: 'google', surface });
    openCalendarLink(buildGoogleCalendarLink({ title: summary, start, end }));
  }

  function handleDownload(): void {
    track(CALENDAR_EVENTS.ADD_OPTION_CLICKED, { option: 'ics', surface });
    downloadIcsEvent({ summary, startIso, durationMinutes, filename });
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button variant="outline" size="sm" onClick={handleGoogle} className="gap-1.5">
        <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
        Add to Google Calendar
      </Button>
      <Button variant="ghost" size="sm" onClick={handleDownload} className="gap-1.5">
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
        Other calendar app
      </Button>
    </div>
  );
}
