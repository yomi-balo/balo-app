/**
 * BAL-473 (ADR-1013 + 2026-07-14 amendment) — meeting-recording pipeline analytics.
 *
 * SERVER-ONLY. Every producer is an `apps/api` webhook arm or BullMQ job. They must NOT be
 * added to `AllEvents` (the client union) nor to the `apps/web/src/test/setup.ts` client mock.
 *
 * Business questions: what share of consultations end with a playable recording; how long
 * after the call it becomes playable; where the pipeline fails.
 *
 * ⚠⚠ NO VENDOR IDS AND NO VENDOR ERROR TEXT LEAVE THE PLATFORM. `recording_id` is
 * `meeting_recordings.id` — OUR uuid — never a Daily recording id, a Mux asset id or an
 * instance id. `reason` is a BOUNDED LABEL, never the vendor's raw message: a Daily error
 * body is arbitrary response text and can contain a signed URL, and PostHog is a third party.
 * The full text lives in `meeting_recordings.failure_reason` and in `log.error`, both
 * server-side. (This narrows the ticket's "free-text reason", deliberately.)
 *
 * `distinct_id` is the MEETING ID on every event — there is no acting human on any of these
 * paths, and it is the same non-user shape `meeting_started` and `guest_joined` already use.
 */
export const RECORDING_SERVER_EVENTS = {
  RECORDING_STARTED: 'recording_started',
  RECORDING_READY: 'recording_ready',
  RECORDING_FAILED: 'recording_failed',
} as const;

/** Which trigger armed the ensure. `rejoin` covers a genuine rejoin AND an idle-auto-stop re-arm. */
export type RecordingTrigger = 'in_progress' | 'rejoin';
/** Where in the pipeline it broke. */
export type RecordingFailureStage = 'daily' | 'mux_ingest' | 'mux_asset';
/**
 * ⚠ A CLOSED SET. Never a vendor string — see the module docblock.
 *
 * ⚠ FIX ROUND 1 (F13) — `'timeout'` REMOVED. No producer in this pipeline ever emits it (the
 * fix round's F7 made `'config_error'` reachable from `recording-ingest.ts`, but nothing maps
 * to `'timeout'`) — a taxonomy value the pipeline cannot produce is a metric nobody can filter
 * on. Add it back deliberately, alongside the producer that emits it, if a future change needs
 * to distinguish a network timeout from the other reasons.
 */
export type RecordingFailureReason =
  | 'vendor_reported'
  | 'daily_api_error'
  | 'mux_api_error'
  | 'config_error'
  | 'unknown';

export interface RecordingServerEventMap {
  [RECORDING_SERVER_EVENTS.RECORDING_STARTED]: {
    meeting_id: string;
    trigger: RecordingTrigger;
    distinct_id: string;
  };
  [RECORDING_SERVER_EVENTS.RECORDING_READY]: {
    meeting_id: string;
    /** ⚠ `meeting_recordings.id`. NEVER a vendor id. */
    recording_id: string;
    duration_seconds: number | null;
    /** `null` when the meeting has no `ended_at` yet (a recording that became playable mid-call). */
    seconds_since_meeting_end: number | null;
    distinct_id: string;
  };
  [RECORDING_SERVER_EVENTS.RECORDING_FAILED]: {
    meeting_id: string;
    stage: RecordingFailureStage;
    reason: RecordingFailureReason;
    distinct_id: string;
  };
}
