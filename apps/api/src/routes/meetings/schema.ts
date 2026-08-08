import { BOOKABLE_CONTEXT_TYPES } from '@balo/shared/meetings';
import { z } from 'zod';

/**
 * `POST /meetings` — book one meeting against EXACTLY ONE context.
 *
 * ⚠ THE LABEL LIST IS NOT DEFINED HERE. `BOOKABLE_CONTEXT_TYPES` lives in
 * `@balo/shared/meetings` because three layers read it and must not disagree: this Zod
 * boundary, the tenancy gate (`services/meetings/authorize-meeting-booking.ts`) and
 * `@balo/analytics`'s `MeetingBookingContextType`. It also removes a layering inversion — the
 * gate used to import this list from a ROUTE directory. Which three labels are excluded, and
 * why, is documented next to the tuple.
 *
 * ⚠ ONE CONTEXT, NOT AN ARRAY. Multi-context meetings are real (a discovery call gains an
 * engagement context at kickoff), but the second row is attached by
 * `meetingContextsRepository.attach`, never by a booking. `create` BOOKS; `attach` TAGS.
 *
 * ⚠ `.datetime()`, NOT `z.coerce.date()`, so a malformed timestamp is a Zod issue the route
 * answers with a clean `400` rather than an `Invalid Date` that reaches a DB CHECK. (That is
 * also why `validateBookingWindow`'s non-finite guard is unreachable from THIS route — but it
 * is public API and BAL-409/410/411 may not use a strict string schema, which is why the guard
 * exists at all.)
 *
 * ⚠ THE CLOCK-DEPENDENT CHECKS ARE NOT HERE. "Is this in the future / long enough / inside
 * the horizon" lives in `validateBookingWindow` (`@balo/shared/meetings`), called from the
 * route with an injected `new Date()`. A module-level Zod `.refine` closing over
 * `new Date()` would freeze `now` AT IMPORT TIME — `apps/api` is a long-lived Fastify
 * process, so a refinement built at boot would judge "is this in the future" against the
 * boot instant forever. Zod issue messages are also not stable error codes, and D10
 * requires stable codes with no message echo.
 */
export const createMeetingBodySchema = z.object({
  contextType: z.enum(BOOKABLE_CONTEXT_TYPES),
  contextId: z.string().uuid(),
  scheduledStart: z.string().datetime(),
  scheduledEnd: z.string().datetime(),
});

export type CreateMeetingBody = z.infer<typeof createMeetingBodySchema>;
