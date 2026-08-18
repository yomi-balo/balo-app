/**
 * BAL-396 §5/§10.6 — the consultation-event write seam. Ships COMPLETE, TESTED and INERT: the
 * booking flow that calls it is BAL-400's (`services/meetings/meeting-availability.ts:70-73`
 * is explicit that booking-time side effects belong to BAL-400/410/411, not to this seam).
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
