'use client';

import { useEffect, useState } from 'react';
import type { AvailabilityView } from '@/components/availability/use-expert-availability';

/**
 * Whether the calendar renders the paused treatment (hatch, banner, `existing_work` read).
 *
 * The server-rendered `availableForWork` is the source of truth for the shading's read scope. The
 * only other input is a latch: a `paused` answer to a `new_work` read (a pause made after this
 * page rendered) holds the paused treatment for the server render it was observed under. The
 * scope is never derived from the answer that scope produced — once latched, the follow-up
 * `existing_work` read answers `ready`, and that answer does not release the latch — so the
 * fetch loop cannot oscillate.
 *
 * `serverRender` is the identity of the server-rendered view object. A refresh (focus,
 * `router.refresh()`, navigation) delivers a new object, which releases the latch: the shading
 * re-reads `new_work` once and re-latches only if the expert is still paused, so a resume made
 * elsewhere is picked up on the next refresh even when `availableForWork` reads `true` both times.
 */
export function useCalendarPaused(
  availableForWork: boolean,
  availabilityView: AvailabilityView | null,
  serverRender: object
): boolean {
  const [latchedFor, setLatchedFor] = useState<object | null>(null);

  useEffect(() => {
    if (availabilityView?.kind === 'paused') setLatchedFor(serverRender);
  }, [availabilityView, serverRender]);

  return !availableForWork || latchedFor === serverRender;
}
