'use client';

import Link from 'next/link';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { track, CALENDAR_EVENTS } from '@/lib/analytics';
import { expertSettingsHrefFor } from '@/lib/constants/expert-checklist';
import {
  CALENDAR_DISCONNECTED_BODY,
  CALENDAR_DISCONNECTED_CTA,
  CALENDAR_DISCONNECTED_TITLE,
} from '../_lib/up-next-copy';

/**
 * BAL-566 (R2) — the expert dashboard's calendar-disconnected banner. Fires when the calendar
 * checklist item is false because of a BROKEN connection (EXPIRED/REVOKED), never for an expert
 * who has simply never connected — same amber tone as `calendar-reconnect-notice.tsx`. A link,
 * never an inline OAuth flow.
 */
export function CalendarDisconnectedBanner(): React.JSX.Element {
  return (
    <div
      role="status"
      className="bg-warning/5 border-warning/20 mb-5 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="text-warning mt-0.5 size-[15px] shrink-0" aria-hidden="true" />
        <div>
          <p className="text-foreground text-sm font-semibold">{CALENDAR_DISCONNECTED_TITLE}</p>
          <p className="text-muted-foreground text-[13px]">{CALENDAR_DISCONNECTED_BODY}</p>
        </div>
      </div>
      <Button
        asChild
        size="sm"
        className="bg-warning hover:bg-warning/90 text-warning-foreground min-h-11 shrink-0 gap-1.5"
      >
        <Link
          href={expertSettingsHrefFor('calendar')}
          onClick={() => track(CALENDAR_EVENTS.CONNECT_CTA_CLICKED, { source: 'dashboard_banner' })}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {CALENDAR_DISCONNECTED_CTA}
        </Link>
      </Button>
    </div>
  );
}
