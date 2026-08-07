import { db } from '../../client';
import { consultations } from '../../schema';
import type { ConsultationStatus, MeetingOutcome, MeetingStatus } from '../../schema';
import { meetingFactory } from '../factories/meeting.factory';

/**
 * THE SHARED FIXTURE MATRIX FOR `_shared/consultation-count.ts` (BAL-428).
 *
 * `consultationCountExpression` is a PUBLIC MARKETPLACE TRUST NUMBER rendered two ways —
 * "N sessions" on the search card (`expertSearchRepository.search`) and "N+" in the profile
 * hero (`expertsRepository.findPublicProfileByUsername`) — from ONE shared SQL expression.
 * The whole reason that expression is shared is so the two surfaces can never disagree, so
 * their FIXTURES must not disagree either: two hand-maintained copies of this matrix would
 * drift, and the file that drifted would keep passing.
 *
 * ⚠ WHY THE MATRIX LOOKS LIKE THIS. Before BAL-428, `consultations` had no production
 * writer, so `status='confirmed'` alone was harmless — the number was always 0. BAL-428 made
 * `consultations` a LIVE PROJECTION of the meeting lifecycle, and
 * `consultationStatusForMeeting` maps every non-cancelled meeting status to `'confirmed'`
 * (correct for AVAILABILITY: a booked future slot must block). Counting the projection
 * directly would therefore have silently redefined the public number to include:
 *
 *   · FUTURE BOOKINGS — a projection row exists the instant a meeting is created, so an
 *     expert with zero delivered calls and three bookings next month would advertise
 *     "3 sessions". Trivially self-inflatable, since the booking side is the CLIENT's.
 *   · NO-SHOWS AND MISSED CALLS — `ended` + `no_show_client` / `missed_call` is not
 *     delivered work.
 *
 * Hence `m.status='ended' AND m.outcome='completed'`. Rows 3–6 below are that fix's
 * regression surface: each one COUNTED before it and must count ZERO after.
 *
 * ⚠ THIS FILE IS TEST-ONLY and lives under `src/test/**`, which is excluded from
 * `sonar.coverage.exclusions` and is NOT in `@balo/db`'s `exports` — it must never become
 * reachable from production code.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface ConsultationCountCase {
  /** Why this row exists, quoted into the assertion message when the count is wrong. */
  label: string;
  meetingStatus: MeetingStatus;
  /** NULL unless `meetingStatus === 'ended'` (CHECK `meeting_outcome_requires_ended`). */
  meetingOutcome: MeetingOutcome | null;
  /** The projection row's own status — `cancelled` must never count. */
  projectionStatus: ConsultationStatus;
  /** Which side (if either) is soft-deleted; both sides are filtered independently. */
  softDelete: 'none' | 'meeting' | 'projection';
  /** Days from now — negative for delivered work, positive for a future booking. */
  offsetDays: number;
  counted: boolean;
}

/**
 * ONE row per fixture consultation. Every row gets its OWN meeting: `consultations.
 * meeting_id` is NOT NULL and `consultations_meeting_uq` is unique per LIVE row, so they
 * cannot share one. Meetings are seeded CONTEXT-FREE (`contexts: []`) on purpose — this
 * matrix is about the count expression's predicates, and real contexts would drag the
 * projection's expert resolver into an unrelated fixture.
 */
export const CONSULTATION_COUNT_MATRIX: readonly ConsultationCountCase[] = [
  {
    label: 'delivered call',
    meetingStatus: 'ended',
    meetingOutcome: 'completed',
    projectionStatus: 'confirmed',
    softDelete: 'none',
    offsetDays: -7,
    counted: true,
  },
  {
    label: 'a second delivered call',
    meetingStatus: 'ended',
    meetingOutcome: 'completed',
    projectionStatus: 'confirmed',
    softDelete: 'none',
    offsetDays: -3,
    counted: true,
  },
  // ── BAL-428 CRITICAL 2 — the four rows the pre-fix expression wrongly counted ──
  {
    // (a) A FUTURE BOOKING. The projection is `confirmed` (it must block the calendar) but
    // nothing has been delivered. Counting it would let a client inflate an expert's public
    // "sessions" number just by booking.
    label: 'a FUTURE booking (meeting still scheduled)',
    meetingStatus: 'scheduled',
    meetingOutcome: null,
    projectionStatus: 'confirmed',
    softDelete: 'none',
    offsetDays: 7,
    counted: false,
  },
  {
    // (b) A NO-SHOW. The call ended, but no client-side participant ever arrived.
    label: 'an ENDED call with outcome=no_show_client',
    meetingStatus: 'ended',
    meetingOutcome: 'no_show_client',
    projectionStatus: 'confirmed',
    softDelete: 'none',
    offsetDays: -5,
    counted: false,
  },
  {
    label: 'an ENDED call with outcome=missed_call (the expert never joined)',
    meetingStatus: 'ended',
    meetingOutcome: 'missed_call',
    projectionStatus: 'confirmed',
    softDelete: 'none',
    offsetDays: -4,
    counted: false,
  },
  {
    label: 'a call IN PROGRESS right now',
    meetingStatus: 'in_progress',
    meetingOutcome: null,
    projectionStatus: 'confirmed',
    softDelete: 'none',
    offsetDays: 0,
    counted: false,
  },
  // ── The pre-existing predicates, still asserted ──
  {
    // `c.status='confirmed'` is retained precisely so this row cannot count even though its
    // meeting reads as delivered.
    label: 'a CANCELLED projection over an otherwise-delivered meeting',
    meetingStatus: 'ended',
    meetingOutcome: 'completed',
    projectionStatus: 'cancelled',
    softDelete: 'none',
    offsetDays: -6,
    counted: false,
  },
  {
    label: 'a SOFT-DELETED projection',
    meetingStatus: 'ended',
    meetingOutcome: 'completed',
    projectionStatus: 'confirmed',
    softDelete: 'projection',
    offsetDays: -8,
    counted: false,
  },
  {
    label: 'a live projection whose MEETING was soft-deleted',
    meetingStatus: 'ended',
    meetingOutcome: 'completed',
    projectionStatus: 'confirmed',
    softDelete: 'meeting',
    offsetDays: -9,
    counted: false,
  },
];

/** What `consultationCountExpression` must report after seeding the matrix. */
export const EXPECTED_CONSULTATION_COUNT: number = CONSULTATION_COUNT_MATRIX.filter(
  (row) => row.counted
).length;

/** The rows that must NOT count, for a failure message that names what leaked. */
export const UNCOUNTED_CONSULTATION_LABELS: readonly string[] = CONSULTATION_COUNT_MATRIX.filter(
  (row) => !row.counted
).map((row) => row.label);

/**
 * Seed one meeting + one projection row per matrix entry against `expertProfileId`.
 *
 * Written RAW rather than through `meetingsRepository.create`: the repository exposes no
 * status mutator (BAL-134 owns the transition map) and refuses an empty `contexts` array, so
 * an `ended`/`in_progress`/soft-deleted fixture is not reachable through it. The
 * `meetingFactory` `values` override is the established precedent for exactly this.
 */
export async function seedConsultationCountMatrix(expertProfileId: string): Promise<void> {
  const now = Date.now();

  for (const row of CONSULTATION_COUNT_MATRIX) {
    const startAt = new Date(now + row.offsetDays * DAY_MS);
    const endAt = new Date(startAt.getTime() + HOUR_MS);

    const { meeting } = await meetingFactory({
      contexts: [],
      values: {
        scheduledStart: startAt,
        scheduledEnd: endAt,
        status: row.meetingStatus,
        outcome: row.meetingOutcome,
        deletedAt: row.softDelete === 'meeting' ? new Date() : null,
      },
    });

    await db.insert(consultations).values({
      meetingId: meeting.id,
      expertProfileId,
      startAt,
      endAt,
      status: row.projectionStatus,
      deletedAt: row.softDelete === 'projection' ? new Date() : null,
    });
  }
}
