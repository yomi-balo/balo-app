'use client';

import { useEffect, useState } from 'react';
import { CalendarCheck, CalendarPlus, Download, ExternalLink } from 'lucide-react';
import { buildGoogleCalendarLink, buildOutlookCalendarLink } from '@balo/shared/calendar';
import type { AddToCalendarEvent } from '@balo/shared/calendar-link-token';
import type { CalendarAddOption } from '@balo/analytics/events';
import { BaloCard } from '@/components/balo/card/balo-card';
import { Button } from '@/components/ui/button';
import { downloadIcsEvent } from '@/components/booking/ics';
import { openCalendarLink } from '@/components/booking/open-calendar-link';
import { CALENDAR_EVENTS, track } from '@/lib/analytics';

export interface AddToCalendarPanelProps {
  event: AddToCalendarEvent;
  /** The call has already ended — nothing left to add. */
  isPast: boolean;
}

/**
 * "Tue, Nov 17 · 9:00 – 10:00 AM GMT+11" in `timeZone`. The zone is named because the invite
 * email shows the same call in UTC — the reader needs to be able to reconcile the two.
 */
export function formatCallWindow(startIso: string, endIso: string, timeZone: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(start);
  const range = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone,
  }).formatRange(start, end);
  return `${day} · ${range}`;
}

/**
 * The browser's zone, read after mount. The server has no idea where the reader is, and Node's and
 * the browser's ICU format a time range with different spacing characters — so the time renders
 * client-side only (a placeholder bar until then) and there is nothing to mismatch on hydration.
 */
function useViewerTimeZone(): string | null {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  return zone;
}

export function AddToCalendarPanel({
  event,
  isPast,
}: Readonly<AddToCalendarPanelProps>): React.JSX.Element {
  const zone = useViewerTimeZone();
  const linkInput = {
    title: event.title,
    start: new Date(event.startIso),
    end: new Date(event.endIso),
    ...(event.details === undefined ? {} : { details: event.details }),
    ...(event.location === undefined ? {} : { location: event.location }),
  };
  const options: { option: CalendarAddOption; label: string; build: () => string }[] = [
    { option: 'google', label: 'Google Calendar', build: () => buildGoogleCalendarLink(linkInput) },
    {
      option: 'outlook_personal',
      label: 'Outlook.com',
      build: () => buildOutlookCalendarLink(linkInput, 'personal'),
    },
    {
      option: 'outlook_work',
      label: 'Outlook for work or school',
      build: () => buildOutlookCalendarLink(linkInput, 'work'),
    },
  ];

  function handleOpen(option: (typeof options)[number]): void {
    track(CALENDAR_EVENTS.ADD_OPTION_CLICKED, { option: option.option, surface: 'invite_page' });
    openCalendarLink(option.build());
  }

  function handleDownload(): void {
    track(CALENDAR_EVENTS.ADD_OPTION_CLICKED, { option: 'ics', surface: 'invite_page' });
    downloadIcsEvent({
      summary: event.title,
      startIso: event.startIso,
      durationMinutes: Math.round((Date.parse(event.endIso) - Date.parse(event.startIso)) / 60_000),
      filename: 'balo-call.ics',
      ...(event.details === undefined ? {} : { description: event.details }),
      ...(event.location === undefined ? {} : { location: event.location }),
    });
  }

  return (
    <BaloCard className="mx-auto w-full max-w-md p-6 sm:p-8">
      <span className="border-primary/30 bg-primary/10 flex h-12 w-12 items-center justify-center rounded-2xl border">
        {isPast ? (
          <CalendarCheck className="text-primary h-6 w-6" aria-hidden="true" />
        ) : (
          <CalendarPlus className="text-primary h-6 w-6" aria-hidden="true" />
        )}
      </span>
      <h1 className="text-foreground mt-4 text-lg font-semibold">{event.title}</h1>
      {zone === null ? (
        <div className="bg-muted mt-2 h-4 w-44 animate-pulse rounded" aria-hidden="true" />
      ) : (
        <p className="text-muted-foreground mt-1 text-sm">
          {formatCallWindow(event.startIso, event.endIso, zone)}
        </p>
      )}

      {isPast ? (
        <p className="text-muted-foreground border-border mt-6 border-t pt-5 text-[13px] leading-relaxed">
          This call has already taken place, so there&apos;s nothing left to add.
        </p>
      ) : (
        <>
          <div className="border-border mt-6 space-y-2 border-t pt-5">
            <p className="text-foreground text-sm font-medium">Add it to your calendar</p>
            {options.map((option) => (
              <Button
                key={option.label}
                variant="outline"
                onClick={() => handleOpen(option)}
                className="w-full justify-between"
              >
                {option.label}
                <ExternalLink className="text-muted-foreground h-4 w-4" aria-hidden="true" />
              </Button>
            ))}
            <Button variant="ghost" onClick={handleDownload} className="w-full justify-between">
              Apple Calendar or another app (.ics)
              <Download className="text-muted-foreground h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <p className="text-muted-foreground mt-5 text-[12px] leading-relaxed">
            Rescheduling and cancelling happen in Balo. An entry added here is your own copy — if
            the time changes, we&apos;ll email you so you can update it.
          </p>
        </>
      )}
    </BaloCard>
  );
}
