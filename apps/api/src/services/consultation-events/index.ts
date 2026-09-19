/**
 * BAL-396 §5/§10.6 — the consultation-event write seam. **LIVE, not inert**: BAL-400 wired
 * booking, BAL-283 added the intro call, BAL-409/411 wired the amend, and BAL-433 Slice 1 made
 * EVERY bookable context project. ⚠ ALL FIVE EXPORTS BELOW NOW HAVE PRODUCTION CALLERS:
 * BAL-476 wired `deleteConsultationEvent`, whose sole consumer is
 * `services/meetings/withdraw-meeting-calendar.ts`'s `withdrawMeetingCalendarProjection`. It
 * runs post-commit off both cancellation producers, inline and best-effort — never inside a
 * retrying job, because this function marks Balo's row FIRST, so attempt 2 finds nothing live
 * and silently performs no vendor delete. BAL-410 shipped the cancel PRODUCER (the state flip,
 * the `meeting.cancelled` audit row whose id is the correlation handle, the credit-hold release,
 * the Daily room delete and the `booking.cancelled` event) and deliberately emits no calendar
 * event and no ICS; BAL-476 consumes that signal.
 *
 * ⚠ `reconcileByTag` GOT ITS FIRST LIVE CALLER IN BAL-475 (fix round 1, F17/S7):
 * `project-booking-to-calendar.ts`'s AMBIGUOUS vendor-create-failure branch
 * (`server_error`/`network`/`unknown` — the response was lost but the event may have
 * committed) calls it before assuming non-creation. Still no SCHEDULED orphan sweep — this is
 * an inline, synchronous reconcile-on-failure, not a background job.
 *
 * ⚠ THE FOUR PROJECTION MODULES ARE DELIBERATELY OFF THIS BARREL and reached by deep path, as
 * `project-booking-to-calendar.ts` already was: `calendar-context-registry.ts`,
 * `resolve-calendar-facts.ts`, `booking-calendar-projection.ts`,
 * `project-booking-to-calendar.ts`. This barrel is the VENDOR write seam; the projection
 * pipeline is a caller of it, and collapsing the two would invite a consumer to reach for a
 * resolver when it wanted a writer.
 */
export { buildConsultationEvent, type ConsultationEventInput } from './event-mapper.js';
export {
  writeConsultationEvent,
  type WriteConsultationEventInput,
} from './write-consultation-event.js';
export {
  deleteConsultationEvent,
  type DeleteConsultationEventInput,
} from './delete-consultation-event.js';
export { reconcileByTag, type ReconcileByTagInput } from './reconcile-by-tag.js';
export {
  updateConsultationEvent,
  type UpdateConsultationEventInput,
} from './update-consultation-event.js';
