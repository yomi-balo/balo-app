'use server';

import 'server-only';

import { z } from 'zod';
import { projectRequestsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';

const inputSchema = z.object({ requestId: z.uuid() });

export type BookExploratoryResult =
  | {
      success: true;
      /** Explicit: this is a stub, not a real booking. */
      mocked: true;
      confirmation: {
        message: string;
        /** Real value lands with the Booking project. */
        scheduledAtIso: null;
      };
    }
  | { success: false; error: string };

/**
 * ⚠️ MOCK SEAM — replaced by the future **Booking project**.
 *
 * The client's "Book exploratory call" CTA. This is a DOWNSTREAM CONFIRMATION
 * STUB and is FULLY DECOUPLED from the state machine: it performs NO status
 * transition, publishes NO notification, and writes NOTHING (no calendar, no
 * slot, no event). The real `requested → exploratory_meeting_requested` transition
 * + the client notification fire from the admin triage action
 * (`request-exploratory-meeting.ts`), so this mock cannot gate the state machine.
 *
 * When the Booking project lands, this action is replaced (same file, same client
 * call-site) by the real calendar-booking action that writes the event and may
 * publish a `booking.confirmed`-style event. File a "related" Linear issue against
 * this seam when that project is created.
 */
export async function bookExploratoryMeetingAction(
  input: z.infer<typeof inputSchema>
): Promise<BookExploratoryResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { success: false, error: 'You must be signed in to book a call.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId } = parsed.data;

  try {
    const request = await projectRequestsRepository.findById(requestId);
    if (request === undefined) {
      return { success: false, error: 'This request no longer exists.' };
    }

    // Only the owning client can book this request's call.
    if (request.companyId !== user.companyId) {
      return { success: false, error: 'You do not have permission to do this.' };
    }

    // The CTA only renders at this status; guard anyway.
    if (request.status !== 'exploratory_meeting_requested') {
      return { success: false, error: 'No exploratory call to book.' };
    }

    log.info('Exploratory call booked (mock)', { requestId, userId: user.id });

    return {
      success: true,
      mocked: true,
      confirmation: {
        message: 'Your exploratory call is booked. Balo will email you the details.',
        scheduledAtIso: null,
      },
    };
  } catch (error) {
    log.error('Failed to book exploratory call (mock)', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not book your call. Please try again.' };
  }
}
