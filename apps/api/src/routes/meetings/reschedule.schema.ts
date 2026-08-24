import { z } from 'zod';

/**
 * BAL-409 — the `POST /meetings/:meetingId/reschedule` body.
 *
 * ⚠ `.datetime()`, NOT `z.coerce.date()` — a malformed timestamp is a clean Zod 400, and Zod
 * messages carry no server-side uuid so echoing `details` is safe house style.
 *
 * ⚠ NO CLOCK-DEPENDENT `.refine` — a module-level refine closing over `new Date()` would freeze
 * `now` at import time. The wall-clock checks (`validateBookingWindow`,
 * `resolveRescheduleRefusal`) run at request time, in the route.
 */
export const rescheduleMeetingBodySchema = z
  .object({
    scheduledStart: z.string().datetime(),
    scheduledEnd: z.string().datetime(),
  })
  .strict();

export type RescheduleMeetingBody = z.infer<typeof rescheduleMeetingBodySchema>;
