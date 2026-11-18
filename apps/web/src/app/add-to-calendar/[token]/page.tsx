import type { Metadata } from 'next';
import { verifyAddToCalendarToken } from '@balo/shared/calendar-link-token';
import { log } from '@/lib/logging';
import { AddToCalendarPanel } from './_components/add-to-calendar-panel';
import { CalendarLinkInvalid } from './_components/calendar-link-invalid';

export const dynamic = 'force-dynamic';

// Public page reached from an email — not indexed, and a NEUTRAL title: the tab and any share
// preview must not name the company, the expert or the call.
export const metadata: Metadata = {
  title: 'Add to calendar — Balo',
  robots: { index: false, follow: false },
};

interface AddToCalendarPageProps {
  /** ⚠ Next 16: this is a Promise and MUST be awaited. */
  params: Promise<{ token: string }>;
}

/**
 * The event comes ONLY from the signed token (`@balo/shared/calendar-link-token`) — no database
 * read, so it works for guests with no account. Anything unsigned, tampered or malformed renders
 * one neutral card; the token itself is never logged (`/add-to-calendar/` is a redacted prefix).
 */
export default async function AddToCalendarPage({
  params,
}: Readonly<AddToCalendarPageProps>): Promise<React.JSX.Element> {
  const { token } = await params;
  const event = verifyAddToCalendarToken(token, process.env.INTERNAL_API_SECRET ?? '');
  if (event === null) {
    log.warn('Add-to-calendar link rejected', { tokenLength: token.length });
    return <CalendarLinkInvalid />;
  }
  return <AddToCalendarPanel event={event} isPast={Date.parse(event.endIso) <= Date.now()} />;
}
