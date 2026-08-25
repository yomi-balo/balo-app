/**
 * BAL-396 §5/§10.6 — the consultation-event write seam. **LIVE, not inert**: BAL-400 wired
 * booking, BAL-283 added the intro call, BAL-409/411 wired the amend, and BAL-433 Slice 1 made
 * EVERY bookable context project. Three of the five exports below have production callers;
 * `deleteConsultationEvent` and `reconcileByTag` still have none (BAL-410 owns the cancel
 * flow, and nothing schedules an orphan sweep).
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
