'use client';

import { CalendarPlus, Download } from 'lucide-react';
import { buildGoogleCalendarLink } from '@balo/shared/calendar';
import { Button } from '@/components/ui/button';
import { downloadIcsEvent } from './ics';

export interface AddToCalendarActionsProps {
  summary: string;
  startIso: string;
  durationMinutes: number;
  filename: string;
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
}: Readonly<AddToCalendarActionsProps>): React.JSX.Element {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const googleCalendarUrl = buildGoogleCalendarLink({ title: summary, start, end });

  function handleDownload(): void {
    downloadIcsEvent({ summary, startIso, durationMinutes, filename });
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button variant="outline" size="sm" asChild className="gap-1.5">
        <a href={googleCalendarUrl} target="_blank" rel="noopener noreferrer">
          <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
          Add to Google Calendar
        </a>
      </Button>
      <Button variant="ghost" size="sm" onClick={handleDownload} className="gap-1.5">
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
        Download .ics
      </Button>
    </div>
  );
}
