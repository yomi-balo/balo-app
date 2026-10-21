/**
 * BAL-607 — per-phase wall-clock timing for `POST /meetings`.
 *
 * Pure: this module owns the vocabulary (phase names, the log message, the field shape) and the
 * timer, and never imports a logger. The route owns the single `log.info` line and passes the
 * timer's `fields()` to it; the booking service only ever sees the narrow `BookingPhaseRecorder`
 * half, so it can report its own phases without being able to read or emit anything.
 *
 * ⚠ THE KEY SET IS FIXED. A phase that did not run on this request (no idempotency key, a
 * non-case context, a `match`-routed discovery) is `null`, never an absent key, so one Axiom
 * query covers every booking.
 *
 * `serviceReplayProbe` is the booking service's own idempotency lookup (the route's `replayProbe`
 * is a separate, earlier read), recorded only when a key is present. `bookingTransaction` times the
 * `bookMeeting` call alone and is recorded only after a fresh create, so neither replay path
 * records it.
 *
 * ⚠ DURATIONS ONLY. The line this feeds carries ids and closed enums alongside these numbers
 * (ADR-1044 §4); nothing in this module can carry a name, an email or a vendor payload.
 */

export const BOOKING_PHASES = [
  'tenancyGate',
  'replayProbe',
  'expertEligibility',
  'caseFunding',
  'expertGuards',
  'vendorFreeBusy',
  'serviceReplayProbe',
  'bookingTransaction',
  'venue',
] as const;

export type BookingPhase = (typeof BOOKING_PHASES)[number];

export type BookingPhaseTimingFields = {
  [P in BookingPhase as `${P}Ms`]: number | null;
} & { totalMs: number };

/** The single message text of the booking-phase line; Axiom queries filter on it verbatim. */
export const BOOKING_PHASE_TIMING_MESSAGE = 'Meeting booking phase timings';

/** The write-only half handed to code that reports a phase but must not read the timer. */
export interface BookingPhaseRecorder {
  record(phase: BookingPhase, elapsedMs: number): void;
}

export interface BookingPhaseTimer extends BookingPhaseRecorder {
  hasRecorded(phase: BookingPhase): boolean;
  fields(): BookingPhaseTimingFields;
}

/**
 * Starts the request clock. `totalMs` is `now()` at `fields()` time minus `now()` at creation, so
 * work outside a named phase (the per-user rate limit, the `parseBodyOr400` Zod validation, the
 * window check) counts in the total only. Fastify's JSON content-type parse runs before the handler
 * creates this clock, so it is EXCLUDED from `totalMs`; the `parseBodyOr400` validation runs
 * inside the handler, so it is INCLUDED.
 * `record` overwrites: each phase runs at most once per request.
 */
export function createBookingPhaseTimer(now: () => number = Date.now): BookingPhaseTimer {
  const startedAt = now();
  const recorded = new Map<BookingPhase, number>();

  return {
    record(phase, elapsedMs) {
      recorded.set(phase, elapsedMs);
    },
    hasRecorded(phase) {
      return recorded.has(phase);
    },
    fields() {
      const entries = BOOKING_PHASES.map((phase) => [`${phase}Ms`, recorded.get(phase) ?? null]);
      return {
        ...Object.fromEntries(entries),
        totalMs: now() - startedAt,
      } as BookingPhaseTimingFields;
    },
  };
}

/**
 * Runs `run` and records its elapsed ms against `phase` — on RESOLVE only. A rejection is
 * rethrown untouched and records nothing, so a refused or failed phase never reads as a
 * completed one. A missing recorder is a plain pass-through.
 */
export async function timeBookingPhase<T>(
  recorder: BookingPhaseRecorder | undefined,
  phase: BookingPhase,
  run: () => Promise<T>,
  now: () => number = Date.now
): Promise<T> {
  const startedAt = now();
  const result = await run();
  recorder?.record(phase, now() - startedAt);
  return result;
}
