import { sql, type SQL } from 'drizzle-orm';
import { expertProfiles } from '../../schema';

/**
 * DELIVERED consultation count for an expert profile, as a correlated scalar subquery.
 *
 * Shared by the search list (tiebreaker + card stat) and the public profile read (hero stat)
 * so the two surfaces can never diverge on what "consultation count" means.
 * `${expertProfiles.id}` correlates to the outer `expert_profiles` row in BOTH
 * `select().from(expertProfiles)` (search) and a relational `findFirst` on
 * `expertProfiles` (public read).
 *
 * ⚠⚠ THE `meetings` JOIN IS LOAD-BEARING (BAL-428) — DO NOT "SIMPLIFY" IT AWAY.
 *
 * This is a PUBLIC MARKETPLACE TRUST NUMBER: it renders as "N sessions" on the search card
 * and "N+" in the profile hero, and its absence is what makes an expert read as "New expert".
 * Until BAL-428 the count was `status='confirmed'` alone, which was harmless only because
 * `consultations` had NO production writer — in production it was always 0.
 *
 * BAL-428 makes `consultations` a LIVE PROJECTION of the meeting lifecycle, and
 * `consultationStatusForMeeting` maps every non-cancelled status to `'confirmed'` (correct
 * for AVAILABILITY — a booked future slot must block, and a past one cannot). Counting that
 * projection directly would therefore have silently redefined the public number to include:
 *
 *   · FUTURE BOOKINGS — a projection row is written the instant a meeting is created, so an
 *     expert with zero delivered calls and three bookings next month would advertise
 *     "3 sessions". Trivially self-inflatable, since the booking side is the CLIENT's.
 *   · NO-SHOWS AND MISSED CALLS — `status='ended'` with `outcome='no_show_client'` or
 *     `'missed_call'` would count as delivered work.
 *
 * So the predicate below is `status='ended' AND outcome='completed'` — DELIBERATELY THE SAME
 * ONE `meetingContextsRepository.consultationTimestampsForEngagements` uses for
 * `lastCompletedConsultationAt`. One definition of "a consultation actually happened",
 * used by both, which is the whole reason this expression is shared in the first place.
 *
 * `c.status='confirmed'` is retained so a CANCELLED projection never counts even if its
 * meeting were somehow `ended`; `deleted_at IS NULL` on both sides excludes soft-deleted
 * rows. Enum literals at QUERY time are always safe — the house restriction is on index
 * predicates and CHECKs.
 */
export const consultationCountExpression: SQL = sql`COALESCE((
  SELECT count(*) FROM consultations c
  JOIN meetings m ON m.id = c.meeting_id
  WHERE c.expert_profile_id = ${expertProfiles.id}
    AND c.status = 'confirmed' AND c.deleted_at IS NULL
    AND m.deleted_at IS NULL
    AND m.status = 'ended' AND m.outcome = 'completed'
), 0)`;
